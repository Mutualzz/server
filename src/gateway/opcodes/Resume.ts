import { GatewayCloseCodes, type GatewayPayload } from "@mutualzz/types";
import { logger } from "../Logger";
import { Send } from "../util/Send";
import { getSession, saveSession } from "../util/Session";
import type { WebSocket } from "../util/WebSocket";

export async function onResume(this: WebSocket, data: GatewayPayload) {
    const resume = data.d;

    const session = await getSession(resume.sessionId);

    if (!session) {
        logger.error(`Session not found for resume: ${resume.sessionId}`);
        await Send(this, {
            op: "InvalidSession",
            d: false,
        });

        return this.close(GatewayCloseCodes.InvalidSession, "Invalid session");
    }

    this.sessionId = resume.sessionId;
    this.userId = session.userId;
    this.sequence = session.seq;

    await saveSession({
        sessionId: this.sessionId,
        userId: this.userId,
        seq: this.sequence,
    });

    await Send(this, {
        op: "Dispatch",
        t: "Resume",
        d: {
            sessionId: this.sessionId,
            seq: this.sequence,
        },
    });

    logger.info(`Session resumed: ${this.sessionId}`);
}
