import { GatewayCloseCodes, type GatewaySession } from "@mutualzz/types";
import { saveSession } from "util/Session";
import { logger } from "../../util/Logger";
import { redis } from "../../util/Redis";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";

export async function onIdentify(this: WebSocket, data: { token: string }) {
    if (this.userId) return;

    const rawSession = await redis.get(`rest:sessions:${data.token}`);
    if (!rawSession) {
        logger.error(
            `Invalid token for session ${this.sessionId}: ${data.token}`,
        );
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Invalid token",
            },
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid token");
    }

    clearTimeout(this.readyTimeout);

    const session: GatewaySession = JSON.parse(rawSession);

    this.userId = session.userId;

    const d = {
        sessionId: this.sessionId,
        user: { id: this.userId },
    };

    await Send(this, {
        op: "Dispatch",
        t: "Ready",
        s: this.sequence++,
        d,
    });

    await saveSession(this.sessionId, this.userId, this.sequence);

    logger.info(
        `Session authenticated: ${this.sessionId} (user: ${this.userId})`,
    );
}
