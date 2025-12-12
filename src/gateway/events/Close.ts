import { logger } from "../Logger";
import type { WebSocket } from "../util/WebSocket";

export async function Close(this: WebSocket, code: number, reason: Buffer) {
    if (!this.sessionId) return;
    logger.info(
        `closed connection for ${this.userId} (Session: ${this.sessionId}) for reason: ${reason.toString()}, code: ${code}`,
    );

    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
}
