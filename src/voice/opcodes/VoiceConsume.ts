import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { Send } from "../util/Common.ts";
import { VoiceDispatchEvents } from "@mutualzz/types";

export default async function VoiceConsume(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    if (!peer.rtpCapabilities)
        throw server.error("MISSING_CAPS", "RTP caps not set");
    if (!peer.receiverTransport)
        throw server.error("NO_RECV_TRANSPORT", "Recv transport missing");

    const producerId = envelope.data?.producerId.toString();

    if (
        !room.router.canConsume({
            producerId,
            rtpCapabilities: peer.rtpCapabilities,
        })
    )
        throw server.error("CANNOT_CONSUME", "Router cannot consume producer");

    const consumer = await peer.receiverTransport.consume({
        producerId,
        rtpCapabilities: peer.rtpCapabilities,
        paused: true,
    });

    peer.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () => {
        peer.consumers.delete(consumer.id);
    });

    consumer.on("producerclose", () => {
        peer.consumers.delete(consumer.id);

        peer.socket.send(
            JSON.stringify({
                op: VoiceDispatchEvents.VoiceProducerClosed,
                data: { producerId },
            }),
        );
    });

    Send(
        {
            ok: true,
            data: {
                consumerOptions: {
                    id: consumer.id,
                    producerId,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                },
            },
        },
        peer,
        envelope,
    );
}
