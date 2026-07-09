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
    getDispatchesSince,
} from "../util/SessionEventBuffer";
import { Send } from "../util/Send";
import { getSession, saveSession } from "../util/Session";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";
import { VoiceStateService } from "@mutualzz/gateway/voice/VoiceState.service.ts";

export async function onResume(this: WebSocket, data: GatewayPayload) {
    const resume = data.d;
    const clientSeq = Number(resume.seq ?? 0);

    const rawSession = await redis.get(`rest:sessions:${resume.token}`);
    if (!rawSession) {
        await Send(this, {
            op: "InvalidSession",
            d: false,
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid token");
    }

    const restSession: RESTSession = JSON.parse(rawSession);
    const session = await getSession(resume.sessionId);

    if (!session || session.userId !== restSession.userId.toString()) {
        logger.error(`Session not found for resume: ${resume.sessionId}`);
        await Send(this, {
            op: "InvalidSession",
            d: false,
        });

        return this.close(GatewayCloseCodes.InvalidSession, "Invalid session");
    }

    if (!canResumeFromSeq(resume.sessionId, clientSeq, session.seq)) {
        logger.warn(
            `Resume buffer miss for session ${resume.sessionId} (client seq ${clientSeq}, server seq ${session.seq})`,
        );
        await Send(this, {
            op: "InvalidSession",
            d: false,
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Resume buffer miss");
    }

    this.sessionId = resume.sessionId;
    this.userId = session.userId;
    this.sequence = session.seq;

    const user = await getUser(this.userId, true);
    if (!user) {
        logger.error(`User not found for resume: ${this.userId}`);
        await Send(this, {
            op: "InvalidSession",
            d: false,
        });

        return this.close(GatewayCloseCodes.InvalidSession, "Invalid session");
    }

    this.memberListSubs = this.memberListSubs ?? new Map();
    this.presences = this.presences ?? new Map();
    this.presenceSubs = this.presenceSubs ?? new Set();

    await PresenceService.onSocketAuthenticated(this);
    await setupListener.call(this);

    const missed = getDispatchesSince(resume.sessionId, clientSeq);

    for (const event of missed) {
        await Send(this, {
            op: "Dispatch",
            t: event.t,
            d: event.d,
            s: event.s,
        });
        this.sequence = Math.max(this.sequence, event.s);
    }

    await saveSession({
        sessionId: this.sessionId,
        userId: user.id,
        seq: this.sequence,
    });

    await Send(this, {
        op: "Dispatch",
        t: "Resume",
        d: {
            sessionId: this.sessionId,
            seq: this.sequence,
        },
        s: this.sequence++,
    });

    logger.info(
        `Session resumed: ${this.sessionId} (replayed ${missed.length} events)`,
    );

    await VoiceStateService.sendRejoinIfNeeded(this);
}
