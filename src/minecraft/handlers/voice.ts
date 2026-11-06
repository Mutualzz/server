import {
  bridgesTable,
  bridgeVoiceBindingsTable,
  channelsTable,
  db,
} from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import {
  minecraftPlayerData,
  minecraftVoiceJoinData,
  minecraftVoiceStateData,
} from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import { VoiceStateRedis } from "../../gateway/voice/VoiceState.redis.ts";
import { VoiceStateService } from "../../gateway/voice/VoiceState.service";
import { publishBridgeEvent } from "../BridgeBus";
import { sendToSocket, type MinecraftSession } from "../SessionRegistry";
import type { BridgeVoicePayload, MinecraftPayload } from "../types";
import { MinecraftVoicePeers } from "../voice/MinecraftVoicePeers.ts";
import {
  getMinecraftAudioWsUrl,
  mintMinecraftAudioToken,
  revokeMinecraftAudioTokenForUser,
} from "../voice/audioTokens.ts";
import { findLinkByUuid, fromSession, makeEventId, parseData } from "./shared";

const logger = new Logger({ tag: "MinecraftWS" });

const sanitizeRoomName = (raw: string) => {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return cleaned || "default";
};

export const handleVoiceJoin = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const join = parseData(session.socket, payload, minecraftVoiceJoinData);
  if (!join) return;

  const { uuid, name } = join;
  const room = sanitizeRoomName(join.room);

  const reply = (d: Record<string, unknown>) => {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "VOICE_RESULT",
      d: { action: "join", uuid, name, room, ...d },
    });
  };

  const link = await findLinkByUuid(uuid);
  if (!link) {
    reply({
      ok: false,
      code: "not_linked",
      message: "Link your account first with /mzlink",
    });
    return;
  }

  const binding = await db.query.bridgeVoiceBindingsTable.findFirst({
    where: and(
      eq(bridgeVoiceBindingsTable.bridgeId, BigInt(session.bridgeId)),
      eq(bridgeVoiceBindingsTable.serverId, session.serverId),
      eq(bridgeVoiceBindingsTable.name, room),
    ),
  });
  if (!binding) {
    reply({
      ok: false,
      code: "no_binding",
      message: `No Mutualzz voice channel bound for room "${room}"`,
    });
    return;
  }

  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, BigInt(session.bridgeId)),
  });
  if (!bridge) {
    reply({
      ok: false,
      code: "no_bridge",
      message: "Bridge not found",
    });
    return;
  }

  const userId = link.userId.toString();
  const result = await VoiceStateService.joinFromMinecraft({
    userId,
    spaceId: bridge.spaceId.toString(),
    channelId: binding.channelId.toString(),
  });

  if (!result.ok) {
    reply({
      ok: false,
      code: result.code,
      message: result.message,
    });
    return;
  }

  try {
    await MinecraftVoicePeers.join({
      userId,
      minecraftUuid: uuid,
      voiceEndpoint: result.credentials.voiceEndpoint,
      voiceToken: result.credentials.voiceToken,
      sessionId: result.credentials.sessionId,
      roomId: result.credentials.roomId,
      spaceId: result.credentials.spaceId,
      channelId: result.credentials.channelId,
    });

    const state = await VoiceStateRedis.getState(userId);
    MinecraftVoicePeers.get(userId)?.setLocalMuted(
      !!state?.spaceMute || !!state?.spaceDeaf,
    );
  } catch (err) {
    logger.error(`Hub voice peer join failed for ${userId}: ${err}`);
    await VoiceStateService.leaveFromMinecraft(userId);
    reply({
      ok: false,
      code: "voice_peer_failed",
      message: "Failed to connect to Mutualzz voice",
    });
    return;
  }

  const audio = await mintMinecraftAudioToken({
    userId,
    sessionId: result.credentials.sessionId,
    minecraftUuid: uuid,
  });

  let channelName = "";
  try {
    const channel = await db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, binding.channelId),
    });
    channelName = channel?.name?.trim() || "";
  } catch {
    // ignore — HUD falls back to room key
  }

  reply({
    ok: true,
    message: channelName ? `Joined #${channelName}` : "Joined Mutualzz voice",
    userId,
    spaceId: result.credentials.spaceId,
    channelId: result.credentials.channelId,
    channelName,
    room,
    roomId: result.credentials.roomId,
    audioWsUrl: getMinecraftAudioWsUrl(),
    audioToken: audio.token,
  });

  const eventId = makeEventId(session, "voice_join", uuid);
  const voiceData: BridgeVoicePayload = {
    ...fromSession(session, eventId),
    uuid,
    name,
    userId,
    channelId: result.credentials.channelId,
    channelName: channelName || undefined,
    room,
  };
  await publishBridgeEvent({
    type: "VOICE_JOIN",
    bridgeId: session.bridgeId,
    sourceId: eventId,
    data: voiceData,
  });
};

export const handleVoiceLeave = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const player = parseData(session.socket, payload, minecraftPlayerData);
  if (!player) return;

  const { uuid, name } = player;

  const reply = (d: Record<string, unknown>) => {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "VOICE_RESULT",
      d: { action: "leave", uuid, name, ...d },
    });
  };

  const link = await findLinkByUuid(uuid);
  if (!link) {
    reply({
      ok: false,
      code: "not_linked",
      message: "Account is not linked",
    });
    return;
  }

  const userId = link.userId.toString();

  let channelId = "";
  let channelName = "";
  try {
    const state = await VoiceStateRedis.getState(userId);
    if (state?.client === "minecraft" && state.channelId) {
      channelId = String(state.channelId);
      const channel = await db.query.channelsTable.findFirst({
        where: eq(channelsTable.id, BigInt(channelId)),
      });
      channelName = channel?.name?.trim() || "";
    }
  } catch {
    // ignore — announce without channel name
  }

  await revokeMinecraftAudioTokenForUser(userId);
  const left = await VoiceStateService.leaveFromMinecraft(userId);
  const channelLabel = channelName ? `#${channelName}` : "Mutualzz voice";
  reply({
    ok: true,
    left,
    channelId: channelId || undefined,
    channelName: channelName || undefined,
    message: left ? `Left ${channelLabel}` : "You were not in Mutualzz voice",
    userId,
  });

  if (!left) return;

  const eventId = makeEventId(session, "voice_leave", uuid);
  const voiceData: BridgeVoicePayload = {
    ...fromSession(session, eventId),
    uuid,
    name,
    userId,
    channelId: channelId || undefined,
    channelName: channelName || undefined,
  };
  await publishBridgeEvent({
    type: "VOICE_LEAVE",
    bridgeId: session.bridgeId,
    sourceId: eventId,
    data: voiceData,
  });
};

export const handleVoiceState = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const state = parseData(session.socket, payload, minecraftVoiceStateData);
  if (!state) return;

  const { uuid, selfMute, selfDeaf } = state;

  const link = await findLinkByUuid(uuid);
  if (!link) return;

  await VoiceStateService.updateMinecraftSelfState({
    userId: link.userId.toString(),
    selfMute,
    selfDeaf,
  });
};
