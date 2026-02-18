import type { PresencePayload, Snowflake } from "@mutualzz/types";
import { redis } from "@mutualzz/util";

interface Entry {
    presence: PresencePayload;
    expiresAt: number;
}

const presenceKey = (userId: Snowflake) => `presence:${userId}`;

export class PresenceStore {
    private entries = new Map<Snowflake, Entry>();

    private ttlMs = 10 * 60_000;

    upsert(userId: string, presence: Omit<PresencePayload, "updatedAt">) {
        const now = Date.now();
        const newEntry: PresencePayload = { ...presence, updatedAt: now };

        this.entries.set(userId as any, {
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

    touch(userId: Snowflake) {
        const entry = this.entries.get(userId);
        if (!entry) return;
        entry.expiresAt = Date.now() + this.ttlMs;
    }

    async warmFromRedis(userId: string): Promise<void> {
        const existing = await this.get(userId);
        if (existing) return;

        const raw = await redis.get(presenceKey(userId)).catch(() => null);
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw) as PresencePayload;

            // Basic shape/expiry guard
            const updatedAt = Number(parsed?.updatedAt ?? 0);
            if (!updatedAt) return;

            const expiresAt = updatedAt + this.ttlMs;
            if (expiresAt <= Date.now()) return;

            this.entries.set(userId, {
                presence: parsed,
                expiresAt,
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

            if (!parsed.updatedAt || parsed.updatedAt + this.ttlMs <= now) {
                return null;
            }

            this.entries.set(userId, {
                presence: parsed,
                expiresAt: parsed.updatedAt + this.ttlMs,
            });

            return parsed;
        } catch {
            return null;
        }
    }

    setOffline(userId: string) {
        return this.upsert(userId, { status: "offline", activities: [] });
    }

    gc() {
        const now = Date.now();
        for (const [userId, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(userId);
        }
    }
}
