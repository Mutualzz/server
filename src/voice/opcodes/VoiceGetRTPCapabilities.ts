import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";

export default async function VoiceGetRTPCapabilities(
    _server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    Send(
        {
            ok: true,
            data: {
                rtpCapabilities: room.router.rtpCapabilities,
            },
        },
        peer,
        envelope,
    );
}
