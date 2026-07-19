import { GatewayCloseCodes } from "@mutualzz/types";
import { logger } from "../Logger";
import { VoiceStateService } from "../voice/VoiceState.service.ts";
import { RESUME_WINDOW_MS } from "./Constants";
import { clearSessionBuffer, touchSessionBuffer } from "./SessionEventBuffer";
import { revokeSession, saveSession, flushSessionSeq } from "./Session";
import type { WebSocket } from "./WebSocket";

interface SessionEntry {
    sessionId: string;
    userId: string;
    owner: WebSocket;
    live: WebSocket | null;
    expireTimer: NodeJS.Timeout | null;
    sequence: number;
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

function syncSocketSequences(entry: SessionEntry) {
    entry.owner.sequence = entry.sequence;
    if (entry.live) {
        entry.live.sequence = entry.sequence;
    }
}

function copyAppState(from: WebSocket, to: WebSocket) {
    to.memberListSubs = from.memberListSubs ?? new Map();
    to.presences = from.presences ?? new Map();
    to.presenceSubs = from.presenceSubs ?? new Set();
    to.userSubscriptions = from.userSubscriptions ?? {};
    to.events = from.events ?? {};
    to.memberEvents = from.memberEvents ?? {};
    to.listenOptions = from.listenOptions;
    to.sequence = from.sequence;
}

async function destroyEntry(
    entry: SessionEntry,
    options: { revoke?: boolean; leaveVoice?: boolean } = {},
) {
    const revoke = options.revoke ?? true;
    const leaveVoice = options.leaveVoice ?? revoke;

    if (entry.expireTimer) {
        clearTimeout(entry.expireTimer);
        entry.expireTimer = null;
    }

    sessions.delete(entry.sessionId);
    teardownListeners(entry.owner);
    await clearSessionBuffer(entry.sessionId);

    if (revoke) {
        await revokeSession(entry.sessionId).catch(() => null);
    }

    if (!leaveVoice) return;

    try {
        await VoiceStateService.leaveForExpiredGatewaySession(
            entry.userId,
            entry.sessionId,
        );
    } catch (err) {
        logger.error(
            `[SessionRuntime] Failed to leave voice for expired session ${entry.sessionId}:`,
            err,
        );
    }
}

export const SessionRuntime = {
    register(ws: WebSocket) {
        if (!ws.sessionId || !ws.userId) return;

        const existing = sessions.get(ws.sessionId);
        if (existing) {
            void destroyEntry(existing, { revoke: false, leaveVoice: false });
        }

        sessions.set(ws.sessionId, {
            sessionId: ws.sessionId,
            userId: ws.userId,
            owner: ws,
            live: ws,
            expireTimer: null,
            sequence: ws.sequence ?? 0,
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
        return entry.sequence;
    },

    nextSequence(sessionId: string | undefined, socket: WebSocket): number {
        if (sessionId) {
            const entry = sessions.get(sessionId);
            if (entry) {
                const s = entry.sequence;
                entry.sequence = s + 1;
                syncSocketSequences(entry);
                return s;
            }
        }
        return socket.sequence++;
    },

    noteSequence(sessionId: string | undefined, nextSeq: number) {
        if (!sessionId) return;
        const entry = sessions.get(sessionId);
        if (!entry) return;

        entry.sequence = Math.max(entry.sequence, nextSeq);
        syncSocketSequences(entry);
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
                sequence: ws.sequence ?? 0,
            };
            sessions.set(ws.sessionId, entry);
        }

        if (entry.live !== ws) {
            return;
        }

        entry.live = null;

        const nextSeq = this.getSequence(ws.sessionId) ?? ws.sequence;
        const lastEventSeq = Math.max(0, nextSeq - 1);

        await flushSessionSeq(ws.sessionId, lastEventSeq);
        await saveSession({
            sessionId: ws.sessionId,
            userId: ws.userId,
            seq: lastEventSeq,
        }).catch(() => null);
        await touchSessionBuffer(ws.sessionId);

        if (entry.expireTimer) {
            clearTimeout(entry.expireTimer);
        }

        entry.expireTimer = setTimeout(() => {
            void this.expire(ws.sessionId);
        }, RESUME_WINDOW_MS);
        entry.expireTimer.unref?.();

        logger.debug(
            `[SessionRuntime] Detached session ${ws.sessionId} (seq ${lastEventSeq}), resume window ${RESUME_WINDOW_MS}ms`,
        );
    },

    claim(sessionId: string, ws: WebSocket): boolean {
        const entry = sessions.get(sessionId);
        if (!entry) return false;

        if (entry.expireTimer) {
            clearTimeout(entry.expireTimer);
            entry.expireTimer = null;
        }

        const previousLive = entry.live;
        copyAppState(entry.owner, ws);
        entry.sequence = Math.max(entry.sequence, ws.sequence ?? 0);
        ws.sequence = entry.sequence;
        syncSocketSequences(entry);
        entry.live = ws;

        if (
            previousLive &&
            previousLive !== ws &&
            (previousLive.readyState === previousLive.OPEN ||
                previousLive.readyState === previousLive.CONNECTING)
        ) {
            try {
                previousLive.close(
                    GatewayCloseCodes.SessionTimedOut,
                    "session taken over",
                );
            } catch {}
        }

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
        await destroyEntry(entry, { revoke: true, leaveVoice: true });
    },

    async destroy(
        sessionId: string | undefined,
        options: { leaveVoice?: boolean } = {},
    ) {
        if (!sessionId) return;
        const entry = sessions.get(sessionId);
        if (!entry) {
            await clearSessionBuffer(sessionId);
            await revokeSession(sessionId).catch(() => null);
            return;
        }
        await destroyEntry(entry, {
            revoke: true,
            leaveVoice: options.leaveVoice ?? true,
        });
    },
};
