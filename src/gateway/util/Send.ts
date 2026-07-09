import {
    GatewayDispatchEvents,
    GatewayOpcodes,
    type GatewayPayload,
} from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import { bufferDispatchFromPayload } from "./SessionEventBuffer";
import type { WebSocket } from "./WebSocket";

export function Send(socket: WebSocket, data: GatewayPayload) {
    const payload = {
        op: GatewayOpcodes[data.op],
        d: data.d,
        s: data.s,
        t: data.t ? GatewayDispatchEvents[data.t] : undefined,
    };

    if (
        socket.sessionId &&
        payload.op === GatewayOpcodes.Dispatch &&
        payload.s != null &&
        payload.t
    ) {
        bufferDispatchFromPayload(socket.sessionId, {
            op: "Dispatch",
            t: data.t,
            d: data.d,
            s: data.s,
        });
    }

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
            // NOTE: with "as any" it works, lets keep it for now
            const compressed = socket.compressor.compress(encoded as any);
            socket.send(Buffer.from(compressed), { binary: true }, (err) =>
                err ? reject(err) : resolve(null),
            );
        } catch (err) {
            reject(err);
        }
    });
}
