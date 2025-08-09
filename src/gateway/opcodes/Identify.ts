import { UserModel } from "@mutualzz/database";
import {
    GatewayCloseCodes,
    type GatewayPayload,
    type RESTSession,
} from "@mutualzz/types";
import { logger } from "../../util/Logger";
import { redis } from "../../util/Redis";
import { saveSession } from "../util";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";

export async function onIdentify(this: WebSocket, data: GatewayPayload) {
    if (this.userId) return;

    clearTimeout(this.readyTimeout);

    const identify = data.d;

    const rawSession = await redis.get(`rest:sessions:${identify.token}`);
    if (!rawSession) {
        logger.error(
            `Invalid token for session ${this.sessionId}: ${identify.token}`,
        );
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Invalid token",
            },
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid token");
    }

    const session: RESTSession = JSON.parse(rawSession);

    this.sessionId = session.sessionId;

    const user = await UserModel.findById(session.userId);
    if (!user) {
        logger.error(`User not found for session ${this.sessionId}`);
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Invalid user",
            },
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid user");
    }

    this.userId = user.id;
    this.sequence = 0;

    await saveSession({
        sessionId: this.sessionId,
        userId: user.id,
        seq: this.sequence,
    });

    const d = {
        sessionId: this.sessionId,
        user: user.toJSON(),
    };

    await Send(this, {
        op: "Dispatch",
        t: "Ready",
        s: this.sequence++,
        d,
    });

    logger.info(
        `Session authenticated: ${this.sessionId} (user: ${this.userId})`,
    );
}
