import { Server } from "@mutualzz/voice";
import type { VoicePeer } from "@mutualzz/voice/types.ts";

export function validatePeerSession(server: Server, peer: VoicePeer) {
    const activePeer = server.activePeersByUserId.get(peer.userId);

    if (activePeer !== peer) return false;

    return activePeer.sessionId === peer.sessionId;
}
