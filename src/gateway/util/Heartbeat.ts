import { GatewayCloseCodes } from "@mutualzz/types";
import { HEARTBEAT_INTERVAL } from "./Constants";
import type { WebSocket } from "./WebSocket";

export function setHeartbeat(socket: WebSocket) {
    if (socket.heartbeatTimeout) clearTimeout(socket.heartbeatTimeout);

    socket.heartbeatTimeout = setTimeout(() => {
        if (socket.readyState === socket.OPEN) {
            socket.close(
                GatewayCloseCodes.SessionTimedOut,
                "Heartbeat timeout",
            );
        }
    }, HEARTBEAT_INTERVAL * 2); // 90 seconds
}
