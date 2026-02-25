import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";
import type { RtpCapabilities } from "mediasoup/types";

export default function VoiceSetRTPCapabilities(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    peer.rtpCapabilities = envelope.data?.rtpCapabilities as RtpCapabilities;

    Send({ ok: true }, peer, envelope);
}
