import { onLazyRequest } from "@mutualzz/gateway/opcodes/LazyRequest";
import { GatewayOpcodes, type GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { onHeartbeat } from "./Heartbeat";
import { onIdentify } from "./Identify";
import { onResume } from "./Resume";
import { onPresenceUpdate } from "./PresenceUpdate.ts";

export type OPCodeHandler = (this: WebSocket, data: GatewayPayload) => unknown;

export default {
    [GatewayOpcodes.Heartbeat]: onHeartbeat,
    [GatewayOpcodes.Resume]: onResume,
    [GatewayOpcodes.Identify]: onIdentify,
    [GatewayOpcodes.LazyRequest]: onLazyRequest,
    [GatewayOpcodes.PresenceUpdate]: onPresenceUpdate,
} as unknown as Record<keyof typeof GatewayOpcodes, OPCodeHandler>;
