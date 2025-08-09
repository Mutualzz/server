import { GatewayCloseCodes } from "@mutualzz/types";
import { logger } from "../../util/Logger";
import { getSession, saveSession } from "../../util/Session";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";

export async function onResume(this: WebSocket, data: { sessionId: string }) {
    const existing = await getSession(data.sessionId);
    if (!existing) {
        logger.error(`Session not found for resume: ${data.sessionId}`);
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Session not found",
            },
        });

        return this.close(GatewayCloseCodes.InvalidSession, "Invalid session");
    }

    this.userId = existing.userId;
    this.sequence = existing.seq;
    this.sessionId = data.sessionId;

    await Send(this, {
        op: "Dispatch",
        t: "Resume",
        d: {
            sessionId: this.sessionId,
        },
    });

    await saveSession(this.sessionId, this.userId, this.sequence);

    logger.info(`Session resumed: ${this.sessionId}`);
}
