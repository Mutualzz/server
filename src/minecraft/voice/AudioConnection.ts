import { Logger } from "@mutualzz/logger";
import type { IncomingMessage } from "http";
import type { RawData, WebSocket } from "ws";
import { INSTANCE_ID } from "../../util/InstanceId.ts";
import {
  getMinecraftVoicePeerLocation,
  resolveMinecraftAudioToken,
} from "./audioTokens.ts";
import { MinecraftVoicePeers } from "./MinecraftVoicePeers.ts";
import { VoiceStateService } from "../../gateway/voice/VoiceState.service.ts";

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

const extractToken = (socket: WebSocket, request: IncomingMessage) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;

  const auth = request.headers.authorization;
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }

  const protocol = request.headers["sec-websocket-protocol"];
  if (typeof protocol === "string") {
    const parts = protocol.split(",").map((part) => part.trim());
    const bearer = parts.find((part) => part.startsWith("mza_"));
    if (bearer) return bearer;
  }

  return "";
};

export const onMinecraftAudioConnection = (
  socket: WebSocket,
  request: IncomingMessage,
) => {
  void (async () => {
    const token = extractToken(socket, request);
    const record = await resolveMinecraftAudioToken(token);
    if (!record) {
      socket.close(4001, "invalid_token");
      return;
    }

    const peer = MinecraftVoicePeers.get(record.userId);
    if (!peer) {
      const location = await getMinecraftVoicePeerLocation(record.userId);
      if (
        location &&
        location.instanceId !== INSTANCE_ID &&
        location.audioWsUrl
      ) {
        try {
          socket.send(
            JSON.stringify({
              t: "redirect",
              audioWsUrl: location.audioWsUrl,
              userId: record.userId,
            }),
          );
        } catch {}
        socket.close(4003, "wrong_instance");
        return;
      }
      socket.close(4002, "not_in_voice");
      return;
    }

    logger.debug(`Audio WS connected userId=${record.userId}`);
    peer.attachAudioSocket(socket);

    socket.on("message", (raw, isBinary) => {
      const buf = toBuffer(raw);
      if (!isBinary) {
        if (buf.length > 0 && buf[0] === 0x7b) {
          void handleAudioControl(record.userId, buf);
          return;
        }
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
    } catch {}
  })();
};
