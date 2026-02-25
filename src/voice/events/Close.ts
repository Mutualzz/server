import type { Server } from "../Server.ts";
import type { VoicePeer, VoiceRoom } from "../types.ts";

export default function Close(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
) {
    try {
        console.log("VOICE CLOSE", {
            userId: peer.userId,
            roomId: room.roomId,
        });
    } catch {}

    try {
        server.broadcastPeerLeft(room, peer.userId);
    } catch {}

    server.cleanupPeer(room, peer);
}
