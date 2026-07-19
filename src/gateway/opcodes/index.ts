import { onLazyRequest } from "./LazyRequest";
import { GatewayOpcodes, type GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { onHeartbeat } from "./Heartbeat";
import { onIdentify } from "./Identify";
import { onResume } from "./Resume";
import { onPresenceUpdate } from "./PresenceUpdate.ts";
import { onPresenceScheduleSet } from "./PresenceScheduleSet.ts";
import { onPresenceScheduleClear } from "./PresenceScheduleClear.ts";
import { onCustomStatusScheduleSet } from "./CustomStatusScheduleSet.ts";
import { onCustomStatusScheduleClear } from "./CustomStatusScheduleClear.ts";
import { onVoiceStateUpdate } from "@mutualzz/gateway/opcodes/VoiceStateUpdate.ts";
import {
    onSubscribeUser,
    onUnsubscribeUser,
} from "@mutualzz/gateway/opcodes/SubscribeUser.ts";
import { onCallCreate } from "./CallCreate";
import { onCallRespond } from "./CallRespond";

export type OPCodeHandler = (this: WebSocket, data: GatewayPayload) => unknown;

export default {
    [GatewayOpcodes.Heartbeat]: onHeartbeat,
    [GatewayOpcodes.Resume]: onResume,
    [GatewayOpcodes.Identify]: onIdentify,
    [GatewayOpcodes.LazyRequest]: onLazyRequest,
    [GatewayOpcodes.PresenceUpdate]: onPresenceUpdate,
    [GatewayOpcodes.PresenceScheduleSet]: onPresenceScheduleSet,
    [GatewayOpcodes.PresenceScheduleClear]: onPresenceScheduleClear,
    [GatewayOpcodes.CustomStatusScheduleSet]: onCustomStatusScheduleSet,
    [GatewayOpcodes.CustomStatusScheduleClear]: onCustomStatusScheduleClear,
    [GatewayOpcodes.VoiceStateUpdate]: onVoiceStateUpdate,
    [GatewayOpcodes.SubscribeUser]: onSubscribeUser,
    [GatewayOpcodes.UnsubscribeUser]: onUnsubscribeUser,
    [GatewayOpcodes.CallCreate]: onCallCreate,
    [GatewayOpcodes.CallRespond]: onCallRespond,
} as unknown as Record<keyof typeof GatewayOpcodes, OPCodeHandler>;
