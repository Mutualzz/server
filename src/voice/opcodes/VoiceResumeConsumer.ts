import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";

export default async function VoiceResumeConsumer(
    server: Server,
    __room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const consumerId = envelope.data?.consumerId.toString();
    const consumer = peer.consumers.get(consumerId);
    if (!consumer)
        throw server.error("CONSUMER_NOT_FOUND", "Consumer not found");

    await consumer.resume();
    Send({ ok: true }, peer, envelope);
}
