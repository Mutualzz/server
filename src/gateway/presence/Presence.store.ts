import type {
    PresenceActivity,
    PresencePayload,
    PresenceStatus,
    Snowflake,
} from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import { MAX_ACTIVITIES } from "./Presence.validator.ts";

interface Entry {
    presence: PresencePayload;
    expiresAt: number;
}

export type SessionPresence = Omit<PresencePayload, "updatedAt"> & {
    updatedAt: number;
};

const presenceKey = (userId: Snowflake) => `presence:${userId}`;
const sessionsKey = (userId: Snowflake) => `presence:sessions:${userId}`;

const STATUS_RANK: Record<string, number> = {
    online: 3,
    idle: 2,
    dnd: 1,
};

function mergeSessionPresences(sessions: SessionPresence[]): PresencePayload {
    const now = Date.now();
    if (!sessions.length) {
        return { status: "offline", activities: [], updatedAt: now };
    }

    const visible = sessions.filter(
        (s) => s.status !== "invisible" && s.status !== "offline",
    );

    let status: PresenceStatus;
    if (visible.length === 0) {
        status = sessions.some((s) => s.status === "invisible")
            ? "invisible"
            : "offline";
    } else {
        status = visible.reduce<PresenceStatus>((best, s) => {
            return (STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[best] ?? 0)
                ? s.status
                : best;
        }, visible[0]!.status);
    }

    const sorted = [...sessions].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );

    const custom = sorted
        .flatMap((s) => s.activities ?? [])
        .find((a) => a.type === "custom");

    const activityRichness = (activity: PresenceActivity) =>
        (activity.details ? 2 : 0) + (activity.state ? 1 : 0);

    const games = new Map<string, PresenceActivity>();
    for (const session of sessions) {
        for (const activity of session.activities ?? []) {
            if (activity.type === "custom") continue;
            const key = `${activity.type}:${(activity.name ?? "").toLowerCase()}`;
            const prev = games.get(key);
            if (!prev) {
                games.set(key, activity);
                continue;
            }

            const richness = activityRichness(activity);
            const prevRichness = activityRichness(prev);
            if (richness > prevRichness) {
                games.set(key, {
                    ...activity,
                    applicationId: activity.applicationId ?? prev.applicationId,
                    timestamps: activity.timestamps ?? prev.timestamps,
                });
                continue;
            }
            if (richness < prevRichness) continue;

            if (
                (activity.timestamps?.start ?? Number.POSITIVE_INFINITY) <
                (prev.timestamps?.start ?? Number.POSITIVE_INFINITY)
            ) {
                games.set(key, activity);
            }
        }
    }

    const activities = [
        ...(custom ? [custom] : []),
        ...games.values(),
    ].slice(0, MAX_ACTIVITIES);

    const device =
        sessions.find((s) => s.device === "desktop")?.device ??
        sessions.find((s) => s.device === "mobile")?.device ??
        sessions.find((s) => s.device === "web")?.device;

    return {
        status,
        activities,
        ...(device ? { device } : {}),
        updatedAt: now,
    };
}

export class PresenceStore {
    private entries = new Map<Snowflake, Entry>();
    private ttlMs = 10 * 60_000;

    writeMerged(userId: string, presence: PresencePayload) {
        const now = Date.now();
        const newEntry: PresencePayload = {
            ...presence,
            updatedAt: presence.updatedAt || now,
        };

        this.entries.set(userId, {
            presence: newEntry,
            expiresAt: now + this.ttlMs,
        });

        void redis
            .set(
                presenceKey(String(userId)),
                JSON.stringify(newEntry),
                "PX",
                this.ttlMs,
            )
            .catch(() => {});

        return newEntry;
    }

    upsert(userId: string, presence: Omit<PresencePayload, "updatedAt">) {
        return this.writeMerged(userId, {
            ...presence,
            updatedAt: Date.now(),
        });
    }

    async upsertSession(
        userId: string,
        sessionId: string,
        presence: Omit<PresencePayload, "updatedAt">,
    ): Promise<PresencePayload> {
        const now = Date.now();
        const session: SessionPresence = { ...presence, updatedAt: now };

        await redis
            .hset(sessionsKey(userId), sessionId, JSON.stringify(session))
            .catch(() => null);
        await redis.pexpire(sessionsKey(userId), this.ttlMs).catch(() => null);

        return this.recomputeMerged(userId);
    }

    async setAllSessionsStatus(
        userId: string,
        sessionId: string,
        presence: Omit<PresencePayload, "updatedAt">,
    ): Promise<PresencePayload> {
        const now = Date.now();
        const raw = await redis.hgetall(sessionsKey(userId)).catch(() => null);
        const next: Record<string, string> = {};

        if (raw && Object.keys(raw).length) {
            for (const [id, value] of Object.entries(raw)) {
                try {
                    const existing = JSON.parse(value) as SessionPresence;
                    next[id] = JSON.stringify({
                        ...existing,
                        status: presence.status,
                        updatedAt: now,
                        ...(id === sessionId
                            ? {
                                  activities: presence.activities,
                                  ...(presence.device
                                      ? { device: presence.device }
                                      : {}),
                              }
                            : {}),
                    } satisfies SessionPresence);
                } catch {
                }
            }
        }

        next[sessionId] = JSON.stringify({
            ...presence,
            updatedAt: now,
        } satisfies SessionPresence);

        const entries = Object.entries(next);
        if (entries.length) {
            const pipeline = redis.pipeline();
            for (const [id, value] of entries) {
                pipeline.hset(sessionsKey(userId), id, value);
            }
            pipeline.pexpire(sessionsKey(userId), this.ttlMs);
            await pipeline.exec().catch(() => null);
        }

        return this.recomputeMerged(userId);
    }

    async removeSession(
        userId: string,
        sessionId: string,
    ): Promise<{ merged: PresencePayload; remaining: number }> {
        await redis.hdel(sessionsKey(userId), sessionId).catch(() => null);
        const remaining = await redis
            .hlen(sessionsKey(userId))
            .catch(() => 0);

        if (!remaining) {
            const offline = this.setOffline(userId);
            await redis.del(sessionsKey(userId)).catch(() => null);
            return { merged: offline, remaining: 0 };
        }

        await redis.pexpire(sessionsKey(userId), this.ttlMs).catch(() => null);
        const merged = await this.recomputeMerged(userId);
        return { merged, remaining };
    }

    async getSessions(userId: string): Promise<SessionPresence[]> {
        const raw = await redis.hgetall(sessionsKey(userId)).catch(() => null);
        if (!raw || !Object.keys(raw).length) return [];

        const out: SessionPresence[] = [];
        for (const value of Object.values(raw)) {
            try {
                out.push(JSON.parse(value) as SessionPresence);
            } catch {
                // ignore
            }
        }
        return out;
    }

    async getSession(
        userId: string,
        sessionId: string,
    ): Promise<SessionPresence | null> {
        const raw = await redis
            .hget(sessionsKey(userId), sessionId)
            .catch(() => null);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as SessionPresence;
        } catch {
            return null;
        }
    }

    async recomputeMerged(userId: string): Promise<PresencePayload> {
        const sessions = await this.getSessions(userId);
        const merged = mergeSessionPresences(sessions);
        return this.writeMerged(userId, merged);
    }

    touch(userId: Snowflake) {
        const entry = this.entries.get(userId);
        if (!entry) return;
        entry.expiresAt = Date.now() + this.ttlMs;

        const id = String(userId);
        void redis.pexpire(presenceKey(id), this.ttlMs).catch(() => {});
        void redis.pexpire(sessionsKey(id), this.ttlMs).catch(() => {});
    }

    async warmFromRedis(userId: string): Promise<void> {
        const existing = await this.get(userId as any);
        if (existing) return;

        const raw = await redis.get(presenceKey(userId)).catch(() => null);
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw) as PresencePayload;
            if (!parsed) return;

            this.entries.set(userId as any, {
                presence: parsed,
                expiresAt: Date.now() + this.ttlMs,
            });
        } catch {
            // ignore invalid JSON
        }
    }

    async get(userId: Snowflake): Promise<PresencePayload | null> {
        const now = Date.now();
        const local = this.entries.get(userId);

        if (local) {
            if (local.expiresAt <= now) {
                this.entries.delete(userId);
            } else {
                return local.presence;
            }
        }

        const raw = await redis.get(presenceKey(userId));
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw) as PresencePayload;
            if (!parsed) return null;

            this.entries.set(userId, {
                presence: parsed,
                expiresAt: now + this.ttlMs,
            });

            return parsed;
        } catch {
            return null;
        }
    }

    setOffline(userId: string) {
        return this.writeMerged(userId, {
            status: "offline",
            activities: [],
            updatedAt: Date.now(),
        });
    }

    gc() {
        const now = Date.now();
        for (const [userId, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(userId);
        }
    }
}
