import type { Server } from "../Server.ts";
import type {
    ClientMessageEnvelope,
    TransportDirection,
    VoicePeer,
    VoiceRoom,
} from "../types.ts";
import { Send } from "../util/Common.ts";
import config from "../Config.ts";
import { getCloudflareTurnCredentials } from "@mutualzz/voice/util/CloudflareTurn.ts";

export default async function VoiceCreateTransport(
    _server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const listenInfos = config.webRtcTransport.listenInfos;

    const direction = envelope.data?.direction as TransportDirection;

    const transport = await room.router.createWebRtcTransport({
        listenInfos,
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        preferTcp: false,
        initialAvailableOutgoingBitrate:
            config.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    if (direction === "send") peer.sendTransport = transport;
    else peer.receiverTransport = transport;

    const iceServers =
        (await getCloudflareTurnCredentials().catch(() => null)) ?? [];

    console.log(iceServers);

    Send(
        {
            ok: true,
            data: {
                transportOptions: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                    iceServers,
                },
            },
        },
        peer,
        envelope,
    );
}
