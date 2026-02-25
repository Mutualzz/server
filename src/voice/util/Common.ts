import type {
    ClientMessageEnvelope,
    ServerResponseEnvelope,
    VoicePeer,
} from "../types.ts";

export const Send = (
    payload: Omit<ServerResponseEnvelope, "id">,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) => {
    peer.socket.send(
        JSON.stringify({
            id: envelope.id,
            ...payload,
        } satisfies ServerResponseEnvelope),
    );
};
