import { onLazyRequest } from "./LazyRequest";
import { GatewayOpcodes, type GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { onHeartbeat } from "./Heartbeat";
import { onIdentify } from "./Identify";
import { onResume } from "./Resume";
import { onPresenceUpdate } from "./PresenceUpdate.ts";
import { onPresenceScheduleSet } from "./PresenceScheduleSet.ts";
import { onPresenceScheduleClear } from "./PresenceScheduleClear.ts";
import { onVoiceStateUpdate } from "@mutualzz/gateway/opcodes/VoiceStateUpdate.ts";

export type OPCodeHandler = (this: WebSocket, data: GatewayPayload) => unknown;

export default {
    [GatewayOpcodes.Heartbeat]: onHeartbeat,
    [GatewayOpcodes.Resume]: onResume,
    [GatewayOpcodes.Identify]: onIdentify,
    [GatewayOpcodes.LazyRequest]: onLazyRequest,
    [GatewayOpcodes.PresenceUpdate]: onPresenceUpdate,
    [GatewayOpcodes.PresenceScheduleSet]: onPresenceScheduleSet,
    [GatewayOpcodes.PresenceScheduleClear]: onPresenceScheduleClear,
    [GatewayOpcodes.VoiceStateUpdate]: onVoiceStateUpdate,
} as unknown as Record<keyof typeof GatewayOpcodes, OPCodeHandler>;
