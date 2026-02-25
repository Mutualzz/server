import type { Server } from "../Server.ts";
import type {
    ClientMessageEnvelope,
    TransportDirection,
    VoicePeer,
    VoiceRoom,
} from "../types.ts";
import { Send } from "../util/Common.ts";
import { logger } from "@mutualzz/voice/Logger.ts";
import config from "../../Config.ts";

export default async function VoiceCreateTransport(
    _server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const listenInfos = config.webRtcTransport.listenInfos;

    const direction = envelope.data?.direction as TransportDirection;

    logger.debug(
        `WebRTC transport options: info=${listenInfos}, IS_PRODUCTION=${process.env.NODE_ENV !== "development"}`,
    );

    const transport = await room.router.createWebRtcTransport({
        listenInfos: listenInfos,
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        preferTcp: false,
        initialAvailableOutgoingBitrate:
            config.webRtcTransport.initialAvailableOutgoingBitrate,
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
