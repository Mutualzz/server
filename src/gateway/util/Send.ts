import {
    GatewayDispatchEvents,
    GatewayOpcodes,
    type GatewayPayload,
    type WireGatewayPayload,
} from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import type { WebSocket } from "./WebSocket";

export function Send(socket: WebSocket, data: GatewayPayload) {
    const payload: WireGatewayPayload = {
        op: GatewayOpcodes[data.op],
        d: data.d,
        s: data.s,
        t: data.t ? GatewayDispatchEvents[data.t] : undefined,
    };

    return new Promise((resolve, reject) => {
        if (socket.readyState !== socket.OPEN)
            return reject(new Error("WebSocket is not open"));

        if (!socket.codec || !socket.compressor || socket.compress === "none") {
            const json = JSON.stringify(payload, JSONReplacer);
            socket.send(json, (err) => (err ? reject(err) : resolve(null)));
            return;
        }

        try {
            const encoded = socket.codec.encode(payload);
            const compressed = socket.compressor.compress(encoded);
            socket.send(Buffer.from(compressed), { binary: true }, (err) =>
                err ? reject(err) : resolve(null),
            );
        } catch (err) {
            reject(err);
        }
    });
}
