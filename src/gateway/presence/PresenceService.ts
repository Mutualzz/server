import type { WebSocket } from "../util/WebSocket";
import { PresenceStore } from "./PresenceStore";
import { Send } from "../util/Send";
import { GatewayCloseCodes, type PresencePayload, type PresenceSchedule, type PresenceStatus, } from "@mutualzz/types";
import { sanitizePresence } from "./PresenceValidator";
import { logger } from "../Logger";
import { PresenceBucket } from "./PresenceBucket";
import { resyncMemberListWindows } from "../util/Calculations";
import { redis } from "@mutualzz/util";

type ResyncKey = string;

const SCHEDULE_KEY = (userId: string) => `presence:schedule:${userId}`;
const SCHEDULE_ZSET = `presence:schedules`; // member=userId score=until(ms)
const SCHEDULE_LOCK = `presence:schedule:worker-lock`;

export class PresenceService {
    private static store = new PresenceStore();
    private static started = false;

    private static resyncTimers = new Map<ResyncKey, NodeJS.Timeout>();

    private static scheduleLoopStarted = false;

    static async onSocketAuthenticated(ws: WebSocket) {
        this.ensureGcLoop();
        this.ensureScheduleLoop();

        PresenceBucket.add(ws);

        ws.memberListSubs = ws.memberListSubs ?? new Map();
        ws.presences = ws.presences ?? new Map();

        if (!ws.userId) return;

        // warm presence from redis so "existing" is consistent across gateways
        await this.store.warmFromRedis(ws.userId).catch(() => null);

        const scheduled = await this.getSchedule(ws.userId).catch(() => null);

        const existing = await this.store.get(ws.userId);
        let presence =
            existing ??
            this.store.upsert(ws.userId, {
                status: "online",
                activities: [],
                device: "desktop",
            });

        if (scheduled && scheduled.until > Date.now()) {
            presence = this.store.upsert(ws.userId, {
                ...(presence ?? { activities: [], device: "web" }),
                status: scheduled.status,
            });
        } else if (scheduled) {
            await this.clearSchedule(ws.userId).catch(() => null);
        }

        this.store.touch(ws.userId);

        await this.broadcast(ws.userId, presence);
        await this.notifyScheduleChanged(
            ws.userId,
            scheduled && scheduled.until > Date.now() ? scheduled : null,
        );
    }

    static onSocketClose(ws: WebSocket) {
        PresenceBucket.remove(ws);

        for (const [key, timer] of this.resyncTimers) {
            if (key.startsWith(`${ws.sessionId}:`)) {
                clearTimeout(timer);
                this.resyncTimers.delete(key);
            }
        }
    }

    static async get(userId: string) {
        return this.store.get(userId);
    }

    static async handleUpdate(ws: WebSocket, rawPresence: any) {
        this.ensureGcLoop();
        this.ensureScheduleLoop();

        if (!ws.userId) {
            ws.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
            return;
        }

        const clean = sanitizePresence(rawPresence);

        const scheduled = await this.getSchedule(ws.userId).catch(() => null);
        if (scheduled && scheduled.until > Date.now()) {
            clean.status = scheduled.status;
        }

        const presence = this.store.upsert(ws.userId, clean);

        await this.broadcast(ws.userId, presence);
    }

    static async onDisconnect(userId?: string) {
        if (!userId) return;
        this.ensureGcLoop();
        this.ensureScheduleLoop();

        if (PresenceBucket.hasAnyAuthenticatedSocket(userId)) return;

        const presence = this.store.setOffline(userId);
        await this.broadcast(userId, presence);
    }

    static async setScheduledStatus(
        userId: string,
        opts: { status: PresenceStatus; durationMs: number },
    ) {
        this.ensureScheduleLoop();

        const now = Date.now();

        await this.store.warmFromRedis(userId).catch(() => null);
        const current = await this.store.get(userId);
        const currentStatus = current?.status ?? "online";

        const schedule: PresenceSchedule = {
            status: opts.status,
            revertTo: currentStatus,
            until: now + Math.max(0, opts.durationMs),
        };

        await this.setSchedule(userId, schedule);

        const applied = this.store.upsert(userId, {
            ...(current ?? { activities: [], device: "web" }),
            status: schedule.status,
        });

        await this.broadcast(userId, applied);
        await this.notifyScheduleChanged(userId, schedule);
    }

    static async clearScheduledStatus(userId: string) {
        this.ensureScheduleLoop();

        const existing = await this.getSchedule(userId).catch(() => null);
        await this.clearSchedule(userId);

        if (existing) {
            await this.store.warmFromRedis(userId).catch(() => null);
            const current = await this.store.get(userId);

            const reverted = this.store.upsert(userId, {
                ...(current ?? { activities: [], device: "web" }),
                status: existing.revertTo ?? "online",
            });

            await this.broadcast(userId, reverted);
        }

        await this.notifyScheduleChanged(userId, null);
    }

    private static ensureGcLoop() {
        if (this.started) return;

        this.started = true;

        setInterval(() => {
            for (const ws of PresenceBucket.authenticatedSockets()) {
                if (ws.userId) this.store.touch(ws.userId);
            }

            this.store.gc();
        }, 30_000).unref?.();
    }

    private static scheduleResyncForTargets(
        userId: string,
        targets: WebSocket[],
    ) {
        for (const ws of targets) {
            const visibilityBySpace = ws.presences;
            if (!visibilityBySpace) continue;

            for (const [spaceId, visibleUserIds] of visibilityBySpace) {
                if (!visibleUserIds.has(userId)) continue;

                const key: ResyncKey = `${ws.sessionId}:${spaceId}`;

                const existingTimer = this.resyncTimers.get(key);
                if (existingTimer) clearTimeout(existingTimer);

                const timer = setTimeout(async () => {
                    this.resyncTimers.delete(key);
                    try {
                        await resyncMemberListWindows.call(ws, String(spaceId));
                    } catch (error) {
                        logger.debug("[Presence] resync failed:", error);
                    }
                }, 250);

                this.resyncTimers.set(key, timer);
            }
        }
    }

    private static async broadcast(userId: string, presence: PresencePayload) {
        const targets = PresenceBucket.socketsSeeingUser(userId);
        if (!targets.length) return;

        const payload = { userId, presence };

        await Promise.allSettled(
            targets.map((socket) =>
                Send(socket, {
                    op: "Dispatch",
                    t: "PresenceUpdate",
                    d: payload,
                    s: socket.sequence++,
                }).catch((error) => {
                    logger.debug("[Presence] send fail:", error);
                }),
            ),
        );

        this.scheduleResyncForTargets(userId, targets);
    }

    private static async notifyScheduleChanged(
        userId: string,
        schedule: PresenceSchedule | null,
    ) {
        const seenBy = PresenceBucket.socketsSeeingUser(userId);
        const selfSockets = PresenceBucket.socketsByUserId(userId);

        const allTargets = new Set<WebSocket>([...seenBy, ...selfSockets]);
        if (allTargets.size === 0) return;

        const payload = { userId, schedule };

        await Promise.allSettled(
            [...allTargets].map((socket) =>
                Send(socket, {
                    op: "Dispatch",
                    t: "PresenceScheduleUpdate",
                    d: payload,
                    s: socket.sequence++,
                }).catch((error) => {
                    logger.debug("[PresenceSchedule] send fail:", error);
                }),
            ),
        );
    }

    private static async getSchedule(
        userId: string,
    ): Promise<PresenceSchedule | null> {
        const raw = await redis.get(SCHEDULE_KEY(userId));
        if (!raw) return null;

        try {
            const parsed = JSON.parse(raw) as PresenceSchedule;
            if (!parsed) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    private static async setSchedule(
        userId: string,
        schedule: PresenceSchedule,
    ) {
        const ttlMs = Math.max(0, schedule.until - Date.now());
        if (ttlMs <= 0) {
            await this.clearSchedule(userId);
            return;
        }

        await redis.set(
            SCHEDULE_KEY(userId),
            JSON.stringify(schedule),
            "PX",
            ttlMs,
        );
        await redis.zadd(SCHEDULE_ZSET, String(schedule.until), userId);
    }

    private static async clearSchedule(userId: string) {
        await redis.del(SCHEDULE_KEY(userId));
        await redis.zrem(SCHEDULE_ZSET, userId);
    }

    private static ensureScheduleLoop() {
        if (this.scheduleLoopStarted) return;
        this.scheduleLoopStarted = true;

        setInterval(async () => {
            const lock = await redis.set(SCHEDULE_LOCK, "1", "PX", 5000, "NX");
            if (lock !== "OK") return;

            try {
                await this.processDueSchedules();
            } catch (error) {
                logger.debug("[PresenceSchedule] worker error:", error);
            }
        }, 1000).unref?.();
    }

    private static async processDueSchedules() {
        const now = Date.now();

        const dueUserIds = await redis.zrangebyscore(
            SCHEDULE_ZSET,
            "-inf",
            String(now),
            "LIMIT",
            0,
            200,
        );

        if (!dueUserIds.length) return;

        for (const userId of dueUserIds) {
            const schedule = await this.getSchedule(userId);

            if (!schedule) {
                await redis.zrem(SCHEDULE_ZSET, userId);
                continue;
            }

            if (schedule.until > now) continue;

            await this.store.warmFromRedis(userId).catch(() => null);
            const current = await this.store.get(userId);

            const reverted = this.store.upsert(userId, {
                ...(current ?? { activities: [], device: "web" }),
                status: schedule.revertTo ?? "online",
            });

            await this.broadcast(userId, reverted);
            await this.clearSchedule(userId);
            await this.notifyScheduleChanged(userId, null);
        }
    }
}
