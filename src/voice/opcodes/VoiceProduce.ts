import type { Server } from "../Server.ts";
import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import { redis, verifyVoiceToken } from "@mutualzz/util";
import { Send } from "@mutualzz/voice/util/Common.ts";
import { VoiceDispatchEvents } from "@mutualzz/types";

export default async function VoiceProduce(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    envelope: ClientMessageEnvelope,
) {
    const { transportId, kind, rtpParameters } = envelope.data;

    if (kind !== "audio")
        throw server.error("INVALID_KIND", "Only audio is supported for now");

    if (!peer.sendTransport || peer.sendTransport.id !== transportId)
        throw server.error("BAD_TRANSPORT", "Send transport not ready");

    const voiceToken: string | null = peer.voiceToken ?? null;
    if (!voiceToken) throw server.error("UNAUTHORIZED", "Missing voice token");

    const session = await verifyVoiceToken(voiceToken);
    if (!session) throw server.error("UNAUTHORIZED", "Invalid voice token");

    const currentToken = await redis.get(`voice:currentToken:${peer.userId}`);
    if (currentToken && currentToken !== voiceToken)
        throw server.error("UNAUTHORIZED", "Voice token has been rotated");

    if (session.userId !== peer.userId)
        throw server.error(
            "VOICE_TOKEN_MISMATCH",
            "Voice token does not match user",
        );

    if (session.roomId !== peer.roomId)
        throw server.error(
            "VOICE_TOKEN_MISMATCH",
            "Voice token does not match room",
        );

    const rawState = await redis.get(`voice:state:${peer.userId}`);
    if (!rawState)
        throw server.error("VOICE_STATE_NOT_FOUND", "Voice state not found");

    let state: any;
    try {
        state = JSON.parse(rawState);
    } catch (err) {
        throw server.error("VOICE_STATE_INVALID", "Voice state is invalid");
    }

    if (!state.channelId)
        throw server.error("NOT_IN_VOICE", "User is not in a voice channel");

    const shouldStartPaused = Boolean(state.selfMute || state.spaceMute);

    const producer = await peer.sendTransport.produce({
        kind: "audio",
        rtpParameters,
        appData: {
            userId: peer.userId,
        },
    });

    if (shouldStartPaused) {
        try {
            await producer.pause();
        } catch {}
    }

    peer.producers.set(producer.id, producer);

    Send(
        {
            ok: true,
            data: {
                producerId: producer.id,
            },
        },
        peer,
        envelope,
    );

    server.broadcast(
        room,
        {
            op: VoiceDispatchEvents.VoiceNewProducer,
            data: {
                userId: peer.userId,
                producerId: producer.id,
                kind: "audio",
            },
        },
        peer.userId,
    );
}
