import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";
import { VoiceDispatchEvents } from "@mutualzz/types";

export default async function VoiceCloseProducer(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const producerId = envelope.data?.producerId?.toString();
    if (!producerId)
        throw server.error("MISSING_PRODUCER_ID", "producerId required");

    const producer = peer.producers.get(producerId);
    if (!producer)
        throw server.error("PRODUCER_NOT_FOUND", "Producer not found");

    producer.close();
    peer.producers.delete(producerId);

    Send({ ok: true }, peer, envelope);

    server.broadcast(
        room,
        {
            op: VoiceDispatchEvents.VoiceProducerClosed,
            data: { producerId },
        },
        peer.userId,
    );
}
