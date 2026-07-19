import {
    GatewayCloseCodes,
    type GatewayPayload,
    type RESTSession,
} from "@mutualzz/types";
import { getUser, redis } from "@mutualzz/util";
import { setupListener } from "../Listener";
import { logger } from "../Logger";
import {
    canResumeFromSeq,
    getBufferedMaxSeq,
    getDispatchesSince,
} from "../util/SessionEventBuffer";
import { Send } from "../util/Send";
import { getSession, saveSession } from "../util/Session";
import { SessionRuntime } from "../util/SessionRuntime";
import { setHeartbeat } from "../util/Heartbeat";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";
import { VoiceStateService } from "@mutualzz/gateway/voice/VoiceState.service.ts";
import { CallService } from "../call/Call.service";
import { collectVisibleVoiceStates } from "../../util/Helpers";

async function failResume(socket: WebSocket, reason: string) {
    await Send(socket, {
        op: "InvalidSession",
        d: false,
    });
    return socket.close(GatewayCloseCodes.InvalidSession, reason);
}

export async function onResume(this: WebSocket, data: GatewayPayload) {
    const resume = data.d;
    const clientSeq = Number(resume.seq ?? 0);

    clearTimeout(this.readyTimeout);

    const rawSession = await redis.get(`rest:sessions:${resume.token}`);
    if (!rawSession) {
        return failResume(this, "Invalid token");
    }

    const restSession: RESTSession = JSON.parse(rawSession);
    const session = await getSession(resume.sessionId);

    if (!session || session.userId !== restSession.userId.toString()) {
        logger.error(`Session not found for resume: ${resume.sessionId}`);
        return failResume(this, "Invalid session");
    }

    const runtimeNext = SessionRuntime.getSequence(resume.sessionId);
    const bufferedMax = await getBufferedMaxSeq(resume.sessionId);
    const serverLastEventSeq = Math.max(
        session.seq,
        bufferedMax ?? 0,
        runtimeNext != null ? Math.max(0, runtimeNext - 1) : 0,
    );

    if (
        !(await canResumeFromSeq(
            resume.sessionId,
            clientSeq,
            serverLastEventSeq,
        ))
    ) {
        logger.warn(
            `Resume buffer miss for session ${resume.sessionId} (client seq ${clientSeq}, server seq ${serverLastEventSeq})`,
        );
        await SessionRuntime.destroy(resume.sessionId, { leaveVoice: false });
        return failResume(this, "Resume buffer miss");
    }

    this.sessionId = resume.sessionId;
    this.userId = session.userId;

    const claimed = SessionRuntime.claim(resume.sessionId, this);
    if (!claimed) {
        this.sequence = serverLastEventSeq + 1;
    }

    const user = await getUser(this.userId, true);
    if (!user) {
        logger.error(`User not found for resume: ${this.userId}`);
        await SessionRuntime.destroy(resume.sessionId);
        return failResume(this, "Invalid session");
    }

    this.memberListSubs = this.memberListSubs ?? new Map();
    this.presences = this.presences ?? new Map();
    this.presenceSubs = this.presenceSubs ?? new Set();

    if (!claimed) {
        await setupListener.call(this);
        SessionRuntime.register(this);
    }

    setHeartbeat(this);

    const missed = await getDispatchesSince(resume.sessionId, clientSeq);

    for (const event of missed) {
        await Send(this, {
            op: "Dispatch",
            t: event.t,
            d: event.d,
            s: event.s,
        });
        this.sequence = Math.max(this.sequence, event.s + 1);
        SessionRuntime.noteSequence(this.sessionId, this.sequence);
    }

    await PresenceService.onSocketAuthenticated(this);

    await saveSession({
        sessionId: this.sessionId,
        userId: user.id,
        seq: Math.max(0, this.sequence - 1),
    });

    await Send(this, {
        op: "Dispatch",
        t: "Resume",
        d: {
            sessionId: this.sessionId,
            seq: this.sequence,
            calls: await CallService.listActiveCallsForUser(this.userId),
            voiceStates: await collectVisibleVoiceStates(this.userId),
        },
        s: SessionRuntime.nextSequence(this.sessionId, this),
    });

    logger.info(
        `Session resumed: ${this.sessionId} (replayed ${missed.length} events)`,
    );

    await VoiceStateService.sendRejoinIfNeeded(this);
}
