import {
    GatewayDispatchEvents,
    GatewayOpcodes,
    type GatewayPayload,
} from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import { bufferDispatchFromPayload } from "./SessionEventBuffer";
import { SessionRuntime } from "./SessionRuntime";
import { touchSessionSeq } from "./Session";
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

        touchSessionSeq(socket.sessionId, payload.s);
        SessionRuntime.noteSequence(socket.sessionId, payload.s + 1);
    }

    return new Promise((resolve, reject) => {
        const live =
            SessionRuntime.getLiveSocket(socket.sessionId) ?? socket;

        if (live.readyState !== live.OPEN) {
            if (SessionRuntime.isDetached(socket.sessionId)) {
                return resolve(null);
            }
            return reject(new Error("WebSocket is not open"));
        }

        if (!live.codec || !live.compressor || live.compress === "none") {
            const json = JSON.stringify(payload, JSONReplacer);
            live.send(json, (err) => (err ? reject(err) : resolve(null)));
            return;
        }

        try {
            const encoded = live.codec.encode(payload);
            const compressed = live.compressor.compress(encoded as any);
            live.send(Buffer.from(compressed), { binary: true }, (err) =>
                err ? reject(err) : resolve(null),
            );
        } catch (err) {
            reject(err);
        }
    });
}
