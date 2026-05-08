import { VoiceOpcodes } from "@mutualzz/types";

import VoiceGetRTPCapabilities from "./VoiceGetRTPCapabilities";
import VoiceSetRTPCapabilities from "./VoiceSetRTPCapabilities";
import VoiceCreateTransport from "./VoiceCreateTransport";
import VoiceConnectTransport from "./VoiceConnectTransport";
import VoiceProduce from "./VoiceProduce";
import VoiceConsume from "./VoiceConsume";
import VoiceResumeConsumer from "./VoiceResumeConsumer";
import VoiceLeave from "./VoiceLeave";

import type { Server } from "../Server";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types";
import VoiceCloseProducer from "@mutualzz/voice/opcodes/VoiceCloseProducer.ts";

export type OPCodeHandler = (
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) => unknown | Promise<unknown>;

const OPCodeHandlers: Record<number, OPCodeHandler> = {
    [VoiceOpcodes.VoiceGetRTPCapabilities]: VoiceGetRTPCapabilities,
    [VoiceOpcodes.VoiceSetRTPCapabilities]: VoiceSetRTPCapabilities,
    [VoiceOpcodes.VoiceConnectTransport]: VoiceConnectTransport,
    [VoiceOpcodes.VoiceCreateTransport]: VoiceCreateTransport,
    [VoiceOpcodes.VoiceProduce]: VoiceProduce,
    [VoiceOpcodes.VoiceConsume]: VoiceConsume,
    [VoiceOpcodes.VoiceResumeConsumer]: VoiceResumeConsumer,
    [VoiceOpcodes.VoiceCloseProducer]: VoiceCloseProducer,
    [VoiceOpcodes.VoiceLeave]: VoiceLeave,
};

export default OPCodeHandlers;
