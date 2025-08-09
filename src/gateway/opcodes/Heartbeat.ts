import { setHeartbeat } from "../util/Heartbeat";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";

export async function onHeartbeat(this: WebSocket) {
    setHeartbeat(this);
    await Send(this, {
        op: "HeartbeatAck",
        d: {},
    });
}
