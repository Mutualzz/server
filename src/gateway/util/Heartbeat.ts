import { GatewayCloseCodes } from "@mutualzz/types";
import { logger } from "../Logger";
import { HEARTBEAT_INTERVAL } from "./Constants";
import type { WebSocket } from "./WebSocket";

export function setHeartbeat(socket: WebSocket) {
    if (socket.heartbeatTimeout) clearTimeout(socket.heartbeatTimeout);

    socket.isAlive = true;
    socket.heartbeatTimeout = setTimeout(() => {
        if (socket.readyState === socket.OPEN) {
            logger.warn(
                `Heartbeat timeout for session ${socket.sessionId} (user: ${socket.userId})`,
            );
            socket.close(
                GatewayCloseCodes.SessionTimedOut,
                "Heartbeat timeout",
            );
        }
    }, HEARTBEAT_INTERVAL * 2);
}
