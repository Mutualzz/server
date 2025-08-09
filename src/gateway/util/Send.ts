import {
    GatewayDispatchEvents,
    GatewayOpcodes,
    type GatewayPayload,
} from "@mutualzz/types";
import type { WebSocket } from "./WebSocket";

export function Send(socket: WebSocket, data: GatewayPayload) {
    const payload = {
        op: GatewayOpcodes[data.op],
        d: data.d,
        s: data.s,
        t: data.t ? GatewayDispatchEvents[data.t] : undefined,
    };

    return new Promise((resolve, reject) => {
        if (socket.readyState !== socket.OPEN) {
            return reject(new Error("WebSocket is not open"));
        }

        socket.send(JSON.stringify(payload), (err) => {
            if (err) return reject(err);
            else resolve(null);
        });
    });
}
