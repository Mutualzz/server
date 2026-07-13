import { GatewayCloseCodes } from "@mutualzz/types";
import { logger } from "../Logger";
import { RESUME_WINDOW_MS } from "./Constants";
import { clearSessionBuffer } from "./SessionEventBuffer";
import { revokeSession, saveSession } from "./Session";
import type { WebSocket } from "./WebSocket";

interface SessionEntry {
    sessionId: string;
    userId: string;
    owner: WebSocket;
    live: WebSocket | null;
    expireTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, SessionEntry>();

function teardownListeners(ws: WebSocket) {
    try {
        const channel = ws.listenOptions?.channel;
        if (channel) {
            channel.close().catch?.(() => null);
        } else {
            Object.values(ws.events ?? {}).forEach((x) => x?.());
            Object.values(ws.memberEvents ?? {}).forEach((x) => x?.());
            Object.values(ws.userSubscriptions ?? {}).forEach((x) => x?.());
        }

        ws.memberListSubs?.clear();
        ws.events = {};
        ws.memberEvents = {};
        ws.userSubscriptions = {};
    } catch (err) {
        logger.error("[SessionRuntime] teardownListeners failed:", err);
    }
}

function copyAppState(from: WebSocket, to: WebSocket) {
    to.memberListSubs = from.memberListSubs ?? new Map();
    to.presences = from.presences ?? new Map();
    to.presenceSubs = from.presenceSubs ?? new Set();
    to.userSubscriptions = from.userSubscriptions ?? {};
    to.sequence = from.sequence;
}

async function destroyEntry(entry: SessionEntry, revoke = true) {
    if (entry.expireTimer) {
        clearTimeout(entry.expireTimer);
        entry.expireTimer = null;
    }

    sessions.delete(entry.sessionId);
    teardownListeners(entry.owner);
    clearSessionBuffer(entry.sessionId);

    if (revoke) {
        await revokeSession(entry.sessionId).catch(() => null);
    }
}

export const SessionRuntime = {
    register(ws: WebSocket) {
        if (!ws.sessionId || !ws.userId) return;

        const existing = sessions.get(ws.sessionId);
        if (existing) {
            void destroyEntry(existing, false);
        }

        sessions.set(ws.sessionId, {
            sessionId: ws.sessionId,
            userId: ws.userId,
            owner: ws,
            live: ws,
            expireTimer: null,
        });
    },

    getLiveSocket(sessionId: string | undefined): WebSocket | null {
        if (!sessionId) return null;
        return sessions.get(sessionId)?.live ?? null;
    },

    isDetached(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const entry = sessions.get(sessionId);
        return !!entry && entry.live === null;
    },

    has(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        return sessions.has(sessionId);
    },

    getSequence(sessionId: string): number | null {
        const entry = sessions.get(sessionId);
        if (!entry) return null;
        return Math.max(
            entry.owner.sequence,
            entry.live?.sequence ?? 0,
        );
    },

    noteSequence(sessionId: string | undefined, nextSeq: number) {
        if (!sessionId) return;
        const entry = sessions.get(sessionId);
        if (!entry) return;

        entry.owner.sequence = Math.max(entry.owner.sequence, nextSeq);
        if (entry.live) {
            entry.live.sequence = Math.max(entry.live.sequence, nextSeq);
        }
    },

    async detach(ws: WebSocket, code?: number) {
        if (!ws.sessionId || !ws.userId) {
            teardownListeners(ws);
            return;
        }

        if (
            code === GatewayCloseCodes.ForceLogout ||
            code === GatewayCloseCodes.InvalidSession
        ) {
            await this.destroy(ws.sessionId);
            return;
        }

        let entry = sessions.get(ws.sessionId);
        if (!entry) {
            entry = {
                sessionId: ws.sessionId,
                userId: ws.userId,
                owner: ws,
                live: null,
                expireTimer: null,
            };
            sessions.set(ws.sessionId, entry);
        }

        if (entry.live === ws) {
            entry.live = null;
        }

        const seq = this.getSequence(ws.sessionId) ?? ws.sequence;

        await saveSession({
            sessionId: ws.sessionId,
            userId: ws.userId,
            seq,
        }).catch(() => null);

        if (entry.expireTimer) {
            clearTimeout(entry.expireTimer);
        }

        entry.expireTimer = setTimeout(() => {
            void this.expire(ws.sessionId);
        }, RESUME_WINDOW_MS);
        entry.expireTimer.unref?.();

        logger.debug(
            `[SessionRuntime] Detached session ${ws.sessionId} (seq ${seq}), resume window ${RESUME_WINDOW_MS}ms`,
        );
    },

    claim(sessionId: string, ws: WebSocket): boolean {
        const entry = sessions.get(sessionId);
        if (!entry) return false;

        if (entry.expireTimer) {
            clearTimeout(entry.expireTimer);
            entry.expireTimer = null;
        }

        copyAppState(entry.owner, ws);
        entry.live = ws;

        logger.debug(
            `[SessionRuntime] Claimed session ${sessionId} (seq ${ws.sequence})`,
        );

        return true;
    },

    async expire(sessionId: string) {
        const entry = sessions.get(sessionId);
        if (!entry) return;
        if (entry.live) return;

        logger.info(
            `[SessionRuntime] Resume window expired for session ${sessionId}`,
        );
        await destroyEntry(entry, true);
    },

    async destroy(sessionId: string | undefined) {
        if (!sessionId) return;
        const entry = sessions.get(sessionId);
        if (!entry) {
            clearSessionBuffer(sessionId);
            await revokeSession(sessionId).catch(() => null);
            return;
        }
        await destroyEntry(entry, true);
    },
};
