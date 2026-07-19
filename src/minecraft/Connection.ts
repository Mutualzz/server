import {
  bridgeMinecraftServersTable,
  bridgesTable,
  bridgeTokensTable,
  bridgeVoiceBindingsTable,
  channelsTable,
  db,
  minecraftLinkCodesTable,
  minecraftLinksTable,
} from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { Snowflake } from "@mutualzz/util";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { VoiceStateService } from "../gateway/voice/VoiceState.service";
import { VoiceStateRedis } from "../gateway/voice/VoiceState.redis.ts";
import { PresenceService } from "../gateway/presence/Presence.service.ts";
import { publishBridgeEvent } from "./BridgeBus";
import { emitMinecraftLinkUpdate } from "./linkEvents";
import { MinecraftVoicePeers } from "./voice/MinecraftVoicePeers.ts";
import {
  getMinecraftAudioWsUrl,
  mintMinecraftAudioToken,
  revokeMinecraftAudioTokenForUser,
} from "./voice/audioTokens.ts";
import {
  getSession,
  registerSession,
  sendToSocket,
  unregisterSession,
  type MinecraftSession,
} from "./SessionRegistry";
import {
  clearServerPlayers,
  playerJoined,
  playerLeft,
  playersForBridge,
} from "./OnlinePlayers";
import { ensureMember } from "./BridgeMembers";
import { generateLinkCode, hashBridgeToken } from "./tokens";
import type {
  BridgeChatPayload,
  BridgePlayerPayload,
  BridgeVoicePayload,
  MinecraftPayload,
} from "./types";

const logger = new Logger({ tag: "MinecraftWS" });

const resolveBridgePresenceLabels = async (
  bridgeId: string,
  serverId: string,
) => {
  const server = await db.query.bridgeMinecraftServersTable.findFirst({
    where: and(
      eq(bridgeMinecraftServersTable.bridgeId, BigInt(bridgeId)),
      eq(bridgeMinecraftServersTable.serverId, serverId),
    ),
    columns: { displayName: true, serverId: true },
  });

  const rawDisplay = server?.displayName?.trim() || "";
  const customizedServerName =
    rawDisplay && rawDisplay.toLowerCase() !== serverId.toLowerCase()
      ? rawDisplay
      : null;

  return {
    serverName: customizedServerName,
  };
};

const syncMinecraftPresence = async (
  uuid: string,
  bridgeId: string,
  serverId: string,
  type: "JOIN" | "LEAVE",
) => {
  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
  });
  if (!link) return;

  const userId = link.userId.toString();

  if (type === "LEAVE") {
    await PresenceService.clearMinecraftBridgeActivity(userId, bridgeId);
    return;
  }

  const { serverName } = await resolveBridgePresenceLabels(bridgeId, serverId);
  await PresenceService.setMinecraftBridgeActivity(userId, {
    bridgeId,
    serverName,
  });
};

const HEARTBEAT_INTERVAL = 15_000;
const HEARTBEAT_TIMEOUT = 45_000;
const JOIN_SYNC_WINDOW_MS = 5_000;

const touchServerLastSeen = async (bridgeId: string, serverId: string) => {
  await db
    .update(bridgeMinecraftServersTable)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(bridgeMinecraftServersTable.bridgeId, BigInt(bridgeId)),
        eq(bridgeMinecraftServersTable.serverId, serverId),
      ),
    );
};

const parsePayload = (raw: WebSocket.RawData): MinecraftPayload | null => {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.from(raw).toString("utf8");
    return JSON.parse(text) as MinecraftPayload;
  } catch {
    return null;
  }
};

const closeWithError = (
  socket: WebSocket,
  code: string,
  message: string,
  closeCode = 4001,
) => {
  sendToSocket(socket, { op: "error", d: { code, message } });
  socket.close(closeCode, message);
};

export const onMinecraftConnection = (
  socket: WebSocket,
  _req: IncomingMessage,
) => {
  let identified = false;

  sendToSocket(socket, {
    op: "hello",
    d: { heartbeatInterval: HEARTBEAT_INTERVAL },
  });

  const heartbeatTimer = setInterval(() => {
    const session = getSession(socket);
    if (!session) return;
    if (Date.now() - session.lastHeartbeatAt > HEARTBEAT_TIMEOUT) {
      logger.warn(`Heartbeat timeout for session ${session.sessionId}`);
      socket.close(4000, "Heartbeat timeout");
    }
  }, HEARTBEAT_INTERVAL);

  socket.on("message", async (raw) => {
    const payload = parsePayload(raw);
    if (!payload?.op) {
      sendToSocket(socket, {
        op: "error",
        d: { code: "invalid_payload", message: "Invalid JSON payload" },
      });
      return;
    }

    try {
      if (payload.op === "identify") {
        if (identified) {
          sendToSocket(socket, {
            op: "error",
            d: {
              code: "already_identified",
              message: "Already identified",
            },
          });
          return;
        }
        await handleIdentify(socket, payload);
        identified = !!getSession(socket);
        return;
      }

      const session = getSession(socket);
      if (!session) {
        sendToSocket(socket, {
          op: "error",
          d: {
            code: "not_identified",
            message: "Send identify first",
          },
        });
        return;
      }

      session.lastHeartbeatAt = Date.now();

      switch (payload.op) {
        case "heartbeat":
          sendToSocket(socket, { op: "heartbeat_ack" });
          void touchServerLastSeen(session.bridgeId, session.serverId);
          break;
        case "chat":
          await handleChat(session, payload);
          break;
        case "join":
          await handlePlayerEvent(session, payload, "JOIN");
          break;
        case "leave":
          await handlePlayerEvent(session, payload, "LEAVE");
          break;
        case "link":
          await handleLink(session, payload);
          break;
        case "voice_join":
          await handleVoiceJoin(session, payload);
          break;
        case "voice_leave":
          await handleVoiceLeave(session, payload);
          break;
        case "voice_state":
          await handleVoiceState(session, payload);
          break;
        default:
          sendToSocket(socket, {
            op: "error",
            d: {
              code: "unknown_op",
              message: `Unknown op: ${String(payload.op)}`,
            },
          });
      }
    } catch (error) {
      logger.error(`Handler error: ${error}`);
      sendToSocket(socket, {
        op: "error",
        d: { code: "internal", message: "Internal error" },
      });
    }
  });

  socket.on("close", async () => {
    clearInterval(heartbeatTimer);
    const session = getSession(socket);
    if (session) {
      const removed = clearServerPlayers(session.bridgeId, session.serverId);
      for (const player of removed) {
        const link = await db.query.minecraftLinksTable.findFirst({
          where: eq(minecraftLinksTable.minecraftUuid, player.uuid),
        });
        if (link) {
          await VoiceStateService.leaveFromMinecraft(
            link.userId.toString(),
          ).catch((err) =>
            logger.debug(`voice clear on disconnect failed: ${err}`),
          );
        }
        void syncMinecraftPresence(
          player.uuid,
          session.bridgeId,
          session.serverId,
          "LEAVE",
        ).catch((err) =>
          logger.debug(`presence clear on disconnect failed: ${err}`),
        );
      }
      await publishBridgeEvent({
        type: "PRESENCE",
        bridgeId: session.bridgeId,
        sourceId: session.sessionId,
        data: {
          bridgeId: session.bridgeId,
          players: playersForBridge(session.bridgeId),
        },
      });
    }
    await unregisterSession(socket);
  });

  socket.on("error", (error) => {
    logger.error(`Socket error: ${error}`);
  });
};

const handleIdentify = async (socket: WebSocket, payload: MinecraftPayload) => {
  const token = String(payload.d?.token ?? "");
  const serverId = String(payload.d?.serverId ?? "");

  if (!token || !serverId) {
    closeWithError(
      socket,
      "missing_credentials",
      "token and serverId are required",
    );
    return;
  }

  const tokenHash = hashBridgeToken(token);
  const tokenRow = await db.query.bridgeTokensTable.findFirst({
    where: and(
      eq(bridgeTokensTable.tokenHash, tokenHash),
      isNull(bridgeTokensTable.revokedAt),
    ),
  });

  if (!tokenRow) {
    closeWithError(socket, "invalid_token", "Invalid or revoked token", 4003);
    return;
  }

  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, tokenRow.bridgeId),
  });

  if (!bridge || bridge.status !== 0) {
    closeWithError(socket, "bridge_disabled", "Bridge is disabled", 4003);
    return;
  }

  const existingServer = await db.query.bridgeMinecraftServersTable.findFirst({
    where: and(
      eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
      eq(bridgeMinecraftServersTable.serverId, serverId),
    ),
  });

  if (!existingServer) {
    await db.insert(bridgeMinecraftServersTable).values({
      id: BigInt(Snowflake.generate()),
      bridgeId: bridge.id,
      serverId,
      displayName: serverId,
      lastSeenAt: new Date(),
    });
  } else {
    await db
      .update(bridgeMinecraftServersTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(bridgeMinecraftServersTable.id, existingServer.id));
  }

  await db
    .update(bridgeTokensTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(bridgeTokensTable.id, tokenRow.id));

  const sessionId = randomUUID();
  const bridgeId = bridge.id.toString();

  registerSession({
    socket,
    sessionId,
    bridgeId,
    serverId,
    tokenId: tokenRow.id.toString(),
    lastHeartbeatAt: Date.now(),
    readyAt: Date.now(),
  });

  const voiceRooms = await listVoiceRoomNames(bridgeId, serverId);

  sendToSocket(socket, {
    op: "ready",
    d: { bridgeId, serverId, sessionId, voiceRooms },
  });

  logger.info(
    `Minecraft bridge connected bridge=${bridgeId} server=${serverId}`,
  );
};

const listVoiceRoomNames = async (bridgeId: string, serverId: string) => {
  const rows = await db.query.bridgeVoiceBindingsTable.findMany({
    where: and(
      eq(bridgeVoiceBindingsTable.bridgeId, BigInt(bridgeId)),
      eq(bridgeVoiceBindingsTable.serverId, serverId),
    ),
  });
  const names = rows.map((r) => r.name).filter(Boolean);
  if (!names.includes("default")) names.unshift("default");
  return [...new Set(names)];
};

const handleChat = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const name = String(payload.d?.name ?? "Unknown");
  const content = String(payload.d?.content ?? "").trim();
  const uuid = payload.d?.uuid != null ? String(payload.d.uuid) : undefined;

  if (!content) return;

  const messageId = `${session.sessionId}:${Snowflake.generate()}`;
  const data: BridgeChatPayload = {
    bridgeId: session.bridgeId,
    serverId: session.serverId,
    source: "minecraft",
    sourceId: messageId,
    uuid,
    name,
    content,
  };

  await publishBridgeEvent({
    type: "CHAT",
    bridgeId: session.bridgeId,
    sourceId: messageId,
    data,
  });
};

const handlePlayerEvent = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
  type: "JOIN" | "LEAVE",
) => {
  const uuid = String(payload.d?.uuid ?? "");
  const name = String(payload.d?.name ?? "Unknown");
  if (!uuid) return;

  if (type === "JOIN") {
    playerJoined(session.bridgeId, {
      uuid,
      name,
      serverId: session.serverId,
    });
    const link = await db.query.minecraftLinksTable.findFirst({
      where: eq(minecraftLinksTable.minecraftUuid, uuid),
    });
    if (link) {
      void ensureMember(session.bridgeId, link.userId);
    }
  } else {
    playerLeft(session.bridgeId, uuid);
    const link = await db.query.minecraftLinksTable.findFirst({
      where: eq(minecraftLinksTable.minecraftUuid, uuid),
    });
    if (link) {
      void VoiceStateService.leaveFromMinecraft(link.userId.toString());
    }
  }

  void syncMinecraftPresence(
    uuid,
    session.bridgeId,
    session.serverId,
    type,
  ).catch((err) => logger.debug(`presence sync failed: ${err}`));

  const eventId = `${session.sessionId}:${type.toLowerCase()}:${uuid}:${Snowflake.generate()}`;

  const data: BridgePlayerPayload = {
    bridgeId: session.bridgeId,
    serverId: session.serverId,
    source: "minecraft",
    sourceId: eventId,
    uuid,
    name,
  };

  const inSyncWindow =
    type === "JOIN" && Date.now() - session.readyAt < JOIN_SYNC_WINDOW_MS;

  await publishBridgeEvent(
    {
      type,
      bridgeId: session.bridgeId,
      sourceId: eventId,
      data,
    },
    { skipPersist: inSyncWindow },
  );
};

const handleLink = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const uuid = String(payload.d?.uuid ?? "");
  const name = String(payload.d?.name ?? "Unknown");
  const code =
    payload.d?.code != null ? String(payload.d.code).toUpperCase() : null;

  if (!uuid) {
    sendToSocket(session.socket, {
      op: "error",
      d: { code: "missing_uuid", message: "uuid required for link" },
    });
    return;
  }

  const existing = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
  });
  if (existing) {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "LINK_RESULT",
      d: {
        ok: true,
        alreadyLinked: true,
        userId: existing.userId.toString(),
        minecraftUuid: uuid,
        minecraftName: existing.minecraftName,
      },
    });
    return;
  }

  if (code) {
    const row = await db.query.minecraftLinkCodesTable.findFirst({
      where: eq(minecraftLinkCodesTable.code, code),
    });

    if (
      !row ||
      row.usedAt ||
      row.expiresAt.getTime() < Date.now() ||
      !row.userId
    ) {
      sendToSocket(session.socket, {
        op: "dispatch",
        t: "LINK_RESULT",
        d: { ok: false, message: "Invalid or expired code" },
      });
      return;
    }

    await db.insert(minecraftLinksTable).values({
      id: BigInt(Snowflake.generate()),
      userId: row.userId,
      minecraftUuid: uuid,
      minecraftName: name,
      discordId: row.discordId,
    });

    await db
      .update(minecraftLinkCodesTable)
      .set({
        usedAt: new Date(),
        minecraftUuid: uuid,
        minecraftName: name,
      })
      .where(eq(minecraftLinkCodesTable.id, row.id));

    const result = {
      ok: true,
      userId: row.userId.toString(),
      minecraftUuid: uuid,
      minecraftName: name,
    };

    emitMinecraftLinkUpdate(row.userId, {
      minecraftUuid: uuid,
      minecraftName: name,
      discordId: row.discordId,
      createdAt: new Date(),
    });

    void ensureMember(session.bridgeId, row.userId);

    await publishBridgeEvent({
      type: "LINK_RESULT",
      bridgeId: session.bridgeId,
      sourceId: session.sessionId,
      data: result,
    });

    sendToSocket(session.socket, {
      op: "dispatch",
      t: "LINK_RESULT",
      d: result,
    });
    return;
  }

  const newCode = generateLinkCode();
  await db.insert(minecraftLinkCodesTable).values({
    id: BigInt(Snowflake.generate()),
    code: newCode,
    bridgeId: BigInt(session.bridgeId),
    minecraftUuid: uuid,
    minecraftName: name,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const result = {
    ok: true,
    pending: true,
    code: newCode,
    minecraftUuid: uuid,
    message: `Link code: ${newCode} — enter it in Mutualzz within 10 minutes`,
  };

  sendToSocket(session.socket, {
    op: "dispatch",
    t: "LINK_RESULT",
    d: result,
  });
};

const sanitizeRoomName = (raw: string) => {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return cleaned || "default";
};

const handleVoiceJoin = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const uuid = String(payload.d?.uuid ?? "");
  const name = String(payload.d?.name ?? "Unknown");
  const room = sanitizeRoomName(String(payload.d?.room ?? "default"));

  const reply = (d: Record<string, unknown>) => {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "VOICE_RESULT",
      d: { action: "join", uuid, name, room, ...d },
    });
  };

  if (!uuid) {
    reply({
      ok: false,
      code: "missing_uuid",
      message: "uuid required for voice join",
    });
    return;
  }

  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
  });
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

  const eventId = `${session.sessionId}:voice_join:${uuid}:${Snowflake.generate()}`;
  const voiceData: BridgeVoicePayload = {
    bridgeId: session.bridgeId,
    serverId: session.serverId,
    source: "minecraft",
    sourceId: eventId,
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

const handleVoiceLeave = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const uuid = String(payload.d?.uuid ?? "");
  const name = String(payload.d?.name ?? "Unknown");

  const reply = (d: Record<string, unknown>) => {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "VOICE_RESULT",
      d: { action: "leave", uuid, name, ...d },
    });
  };

  if (!uuid) {
    reply({
      ok: false,
      code: "missing_uuid",
      message: "uuid required for voice leave",
    });
    return;
  }

  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
  });
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
  reply({
    ok: true,
    left,
    channelId: channelId || undefined,
    channelName: channelName || undefined,
    message: left
      ? channelName
        ? `Left #${channelName}`
        : "Left Mutualzz voice"
      : "You were not in Mutualzz voice",
    userId,
  });

  if (!left) return;

  const eventId = `${session.sessionId}:voice_leave:${uuid}:${Snowflake.generate()}`;
  const voiceData: BridgeVoicePayload = {
    bridgeId: session.bridgeId,
    serverId: session.serverId,
    source: "minecraft",
    sourceId: eventId,
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

const handleVoiceState = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const uuid = String(payload.d?.uuid ?? "");
  if (!uuid) return;

  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
  });
  if (!link) return;

  const selfMute = payload.d?.selfMute === true;
  const selfDeaf = payload.d?.selfDeaf === true;

  await VoiceStateService.updateMinecraftSelfState({
    userId: link.userId.toString(),
    selfMute,
    selfDeaf,
  });
};
