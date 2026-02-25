import { logger } from "../Logger";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";

export async function Close(this: WebSocket, code: number, reason: Buffer) {
    logger.info(
        `closed connection for ${this.userId} (Session: ${this.sessionId}) for reason: ${reason.toString()}, code: ${code}`,
    );

    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);

    // always remove from bucket
    PresenceService.onSocketClose(this);

    await PresenceService.onDisconnect(this.userId);
}
