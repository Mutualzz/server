import { Logger } from "@mutualzz/logger";
import type { IncomingMessage } from "http";
import type { RawData, WebSocket } from "ws";
import { VoiceStateService } from "../../gateway/voice/VoiceState.service.ts";
import { resolveMinecraftAudioToken } from "./audioTokens.ts";
import { MinecraftVoicePeers } from "./MinecraftVoicePeers.ts";

const logger = new Logger({
    tag: "MinecraftAudioWS",
    level: (process.env.LOG_LEVEL as "debug" | "info" | undefined) ?? "info",
});

const handleAudioControl = async (userId: string, buf: Buffer) => {
    try {
        const msg = JSON.parse(buf.toString("utf8")) as {
            t?: string;
            selfMute?: boolean;
            selfDeaf?: boolean;
        };
        if (msg?.t !== "voice_state") return;
        logger.debug(
            `voice_state userId=${userId} mute=${msg.selfMute === true} deaf=${msg.selfDeaf === true}`,
        );
        await VoiceStateService.updateMinecraftSelfState({
            userId,
            selfMute: msg.selfMute === true,
            selfDeaf: msg.selfDeaf === true,
        });
    } catch (err) {
        logger.debug(`audio control parse failed userId=${userId}: ${err}`);
    }
};

/**
 * Binary downlink: uint16 BE userId length | utf8 userId | PCM s16le mono 48kHz
 * Binary uplink: raw PCM s16le mono 48kHz (entire message)
 */
export const encodeDownlinkFrame = (userId: string, pcm: Buffer) => {
    const idBuf = Buffer.from(userId, "utf8");
    if (idBuf.length > 0xffff) throw new Error("userId too long");
    const out = Buffer.allocUnsafe(2 + idBuf.length + pcm.length);
    out.writeUInt16BE(idBuf.length, 0);
    idBuf.copy(out, 2);
    pcm.copy(out, 2 + idBuf.length);
    return out;
};

const toBuffer = (raw: RawData): Buffer => {
    if (Buffer.isBuffer(raw)) return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw);
    return Buffer.from(raw as ArrayBuffer);
};

export const onMinecraftAudioConnection = (
    socket: WebSocket,
    request: IncomingMessage,
) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const record = resolveMinecraftAudioToken(token);
    if (!record) {
        socket.close(4001, "invalid_token");
        return;
    }

    const peer = MinecraftVoicePeers.get(record.userId);
    if (!peer) {
        socket.close(4002, "not_in_voice");
        return;
    }

    logger.debug(`Audio WS connected userId=${record.userId}`);
    peer.attachAudioSocket(socket);

    socket.on("message", (raw, isBinary) => {
        const buf = toBuffer(raw);
        // Text frames: mute/deafen JSON. Never drop mis-flagged PCM (fall through if not JSON).
        if (!isBinary) {
            if (buf.length > 0 && buf[0] === 0x7b /* '{' */) {
                void handleAudioControl(record.userId, buf);
                return;
            }
            // Some stacks mis-flag binary; still accept non-JSON as PCM.
        }
        if (buf.byteLength < 2) return;
        peer.pushUplinkPcm(buf);
    });

    socket.on("close", () => {
        peer.detachAudioSocket(socket);
        logger.debug(`Audio WS closed userId=${record.userId}`);
    });

    socket.on("error", (err) => {
        logger.warn(`Audio WS error userId=${record.userId}: ${err}`);
    });

    try {
        socket.send(JSON.stringify({ t: "ready", userId: record.userId }));
    } catch {
        // ignore
    }
};
