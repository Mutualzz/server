import type { WebSocket } from "../util/WebSocket";
import { PresenceStore } from "./PresenceStore.ts";
import { Send } from "@mutualzz/gateway/util";
import { GatewayCloseCodes, type PresencePayload } from "@mutualzz/types";
import { sanitizePresence } from "./PresenceValidator.ts";
import { logger } from "../Logger.ts";
import { PresenceBucket } from "./PresenceBucket.ts";
import { resyncMemberListWindows } from "@mutualzz/gateway/util/Calculations.ts";
import { redis } from "@mutualzz/util";

type ResyncKey = string;

const socketsKey = (userId: string) => `presence:sockets:${userId}`;
const SOCKETS_TTL_MS = 120_000;

async function markSocketOnline(userId: string, sessionId: string) {
    const key = socketsKey(userId);

    await redis.sadd(key, sessionId);
    await redis.pexpire(key, SOCKETS_TTL_MS);
}

async function markSocketOffline(userId: string, sessionId: string) {
    const key = socketsKey(userId);
    const count = await redis.srem(key, sessionId);

    if (count === 0) await redis.del(key);
}

async function hasAnySockets(userId: string): Promise<boolean> {
    const count = await redis.scard(socketsKey(userId)).catch(() => 0);
    return count > 0;
}

export class PresenceService {
    private static store = new PresenceStore();
    private static started = false;

    private static resyncTimers = new Map<ResyncKey, NodeJS.Timeout>();

    static async onSocketAuthenticated(ws: WebSocket) {
        this.ensureGcLoop();
        PresenceBucket.add(ws);

        ws.memberListSubs = ws.memberListSubs ?? new Map();
        ws.presences = ws.presences ?? new Map();

        if (!ws.userId) return;

        await this.store.warmFromRedis(ws.userId);

        void markSocketOnline(ws.userId, ws.sessionId).catch(() => {});

        const existing = await this.store.get(ws.userId);
        const presence =
            existing ??
            this.store.upsert(ws.userId, {
                status: "online",
                activities: [],
                device: "desktop",
            });

        this.store.touch(ws.userId);

        await this.broadcast(ws.userId, presence);
    }

    static onSocketClose(ws: WebSocket) {
        PresenceBucket.remove(ws);

        if (ws.userId)
            void markSocketOffline(ws.userId, ws.sessionId).catch(() => {});

        for (const [key, timer] of this.resyncTimers) {
            if (key.startsWith(`${ws.sessionId}:`)) {
                clearTimeout(timer);
                this.resyncTimers.delete(key);
            }
        }
    }

    static get(userId: string) {
        return this.store.get(userId);
    }

    static async handleUpdate(ws: WebSocket, rawPresence: any) {
        this.ensureGcLoop();

        if (!ws.userId) {
            ws.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
            return;
        }

        const clean = sanitizePresence(rawPresence);
        const presence = await this.store.upsert(ws.userId, clean);

        await this.broadcast(ws.userId, presence);
    }

    static async onDisconnect(userId?: string) {
        if (!userId) return;
        this.ensureGcLoop();

        if (PresenceBucket.hasAnyAuthenticatedSocket(userId)) return;
        if (await hasAnySockets(userId)) return;

        const presence = this.store.setOffline(userId);
        await this.broadcast(userId, presence);
    }

    private static ensureGcLoop() {
        if (this.started) return;

        this.started = true;

        setInterval(() => {
            for (const ws of PresenceBucket.authenticatedSockets()) {
                if (!ws.userId) continue;

                this.store.touch(ws.userId);

                void markSocketOnline(ws.userId, ws.sessionId).catch(() => {});
            }

            this.store.gc();
        }, 30_000).unref?.();
    }

    private static scheduleResyncForTargets(
        userId: string,
        targets: WebSocket[],
    ) {
        for (const ws of targets) {
            const visibilityBySub = ws.presences;
            if (!visibilityBySub) continue;

            const spacesNeedingResync = new Set<string>();

            for (const [subKey, visibleUserIds] of visibilityBySub) {
                if (!visibleUserIds.has(userId)) continue;

                // subKey = `${spaceId}:${channelId}:${listId}`
                const spaceId = subKey.split(":")[0];
                if (spaceId) spacesNeedingResync.add(spaceId);
            }

            for (const spaceId of spacesNeedingResync) {
                const key: ResyncKey = `${ws.sessionId}:${spaceId}`;

                const existingTimer = this.resyncTimers.get(key);
                if (existingTimer) clearTimeout(existingTimer);

                const timer = setTimeout(async () => {
                    this.resyncTimers.delete(key);
                    try {
                        await resyncMemberListWindows.call(ws, spaceId);
                    } catch (err) {
                        logger.debug("[Presence] resync failed:", err);
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
            targets.map((sock) =>
                Send(sock, {
                    op: "Dispatch",
                    t: "PresenceUpdate",
                    d: payload,
                    s: sock.sequence++,
                }).catch((err) => {
                    logger.debug("[Presence] send fail:", err);
                }),
            ),
        );

        this.scheduleResyncForTargets(userId, targets);
    }
}
