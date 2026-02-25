import type { IncomingMessage } from "http";
import { type VoiceWebSocket } from "../util/WebSocket";
import type { Server } from "@mutualzz/voice";
import type { VoicePeer } from "@mutualzz/voice/types.ts";
import Message from "@mutualzz/voice/events/Message.ts";
import Close from "@mutualzz/voice/events/Close.ts";
import { logger } from "@mutualzz/voice/Logger.ts";

export default async function Connection(
    this: Server,
    socket: VoiceWebSocket,
    request: IncomingMessage,
) {
    const pendingFrames: string[] = [];
    let ready = false;

    const requestHost = request.headers.host ?? "localhost";
    const url = new URL(request.url ?? "/", `http://${requestHost}`);
    const token = url.searchParams.get("token");

    const voiceSession = await this.verifyVoiceToken(socket, token);
    if (!voiceSession) return;

    socket.sessionId = voiceSession.sessionId;

    const room = await this.getOrCreateRoom(voiceSession.roomId);
    socket.roomId = room.roomId;

    const peer: VoicePeer = {
        userId: voiceSession.userId,
        sessionId: voiceSession.sessionId,
        roomId: voiceSession.roomId,
        voiceToken: token,
        socket,
        producers: new Map(),
        consumers: new Map(),
    };

    const existingActivePeer = this.activePeersByUserId.get(peer.userId);
    if (existingActivePeer)
        if (existingActivePeer.socket !== socket)
            // If it’s literally the same socket, ignore; otherwise replace.
            this.disconnectPeer(
                existingActivePeer,
                4000,
                "New voice connection",
            );

    const existingRoomPeer = room.peers.get(peer.userId);
    if (existingRoomPeer && existingRoomPeer.socket !== socket)
        this.disconnectPeer(existingRoomPeer, 4000, "Replaced in same room");

    room.peers.set(peer.userId, peer);
    this.activePeersByUserId.set(peer.userId, peer);

    this.broadcastPeerJoined(room, peer.userId);

    socket.currentPeerId = peer.userId;

    socket.on("message", (raw) => {
        const rawText =
            typeof raw === "string"
                ? raw
                : Buffer.isBuffer(raw)
                  ? raw.toString("utf8")
                  : ArrayBuffer.isView(raw)
                    ? Buffer.from(
                          raw.buffer,
                          raw.byteOffset,
                          raw.byteLength,
                      ).toString("utf8")
                    : raw instanceof ArrayBuffer
                      ? Buffer.from(raw).toString("utf8")
                      : raw.toString();

        if (!ready) {
            pendingFrames.push(rawText);
            return;
        }

        void Message(this, room, peer, rawText);
    });

    socket.on("close", () => Close(this, room, peer));

    socket.on("error", (error) => {
        logger.error(error);
        try {
            socket.close();
        } catch {}
    });

    ready = true;
    for (const frame of pendingFrames) {
        void Message(this, room, peer, frame);
    }
    pendingFrames.length = 0;
}
