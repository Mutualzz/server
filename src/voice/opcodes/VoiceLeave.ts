import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";

export default async function VoiceLeave(
    _server: Server,
    _room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    Send({ ok: true }, peer, envelope);
    peer.socket.close(1000, "leave");
}
