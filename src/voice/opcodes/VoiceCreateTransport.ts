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

function flattenIceServers(servers: RTCIceServer[]): RTCIceServer[] {
    return servers.flatMap((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.map((url) => ({
            urls: [url],
            ...(server.username && { username: server.username }),
            ...(server.credential && { credential: server.credential }),
        }));
    });
}

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
        enableTcp: true,
        preferUdp: true,
        preferTcp: false,
        initialAvailableOutgoingBitrate:
            config.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    if (direction === "send") peer.sendTransport = transport;
    else peer.receiverTransport = transport;

    const iceServers =
        (await getCloudflareTurnCredentials().catch(() => null)) ?? [];

    const flat = flattenIceServers(iceServers);

    const stun = flat.find((s) => [s.urls].flat()[0].startsWith("stun:"));
    const turnUdp = flat.find((s) =>
        [s.urls].flat()[0].includes("transport=udp"),
    );
    const turnTcp = flat.find(
        (s) =>
            [s.urls].flat()[0].includes("transport=tcp") &&
            [s.urls].flat()[0].startsWith("turns:"),
    );

    const limitedServers = [stun, turnUdp, turnTcp].filter(Boolean);

    Send(
        {
            ok: true,
            data: {
                transportOptions: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                    iceServers: limitedServers,
                },
            },
        },
        peer,
        envelope,
    );
}
