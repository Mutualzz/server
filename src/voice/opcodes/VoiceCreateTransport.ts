import type { Server } from "../Server.ts";
import type {
    ClientMessageEnvelope,
    TransportDirection,
    VoicePeer,
    VoiceRoom,
} from "../types.ts";
import { Send } from "../util/Common.ts";

export default async function VoiceCreateTransport(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const direction = envelope.data?.direction as TransportDirection;

    const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: server.listenIp, announcedIp: server.announcedIp }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 800_000,
    });

    if (direction === "send") peer.sendTransport = transport;
    else peer.receiverTransport = transport;

    Send(
        {
            ok: true,
            data: {
                transportOptions: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                },
            },
        },
        peer,
        envelope,
    );
}
