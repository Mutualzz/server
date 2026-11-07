import {
  minecraftChatData,
  minecraftGameEventData,
  minecraftPlayerData,
  minecraftServerStatusData,
} from "@mutualzz/validators";
import { Logger } from "@mutualzz/logger";
import { Snowflake } from "@mutualzz/util";
import { VoiceStateService } from "../../gateway/voice/VoiceState.service";
import { publishBridgeEvent } from "../BridgeBus";
import { ensureMember } from "../BridgeMembers";
import { deliverPendingEdits } from "../InventoryEdits.ts";
import { startInventoryWatchIfViewed } from "../InventoryViewers.ts";
import { playerJoined, playerLeft } from "../OnlinePlayers";
import { setServerStatus } from "../ServerStatuses.ts";
import type { MinecraftSession } from "../SessionRegistry";
import type {
  BridgeChatPayload,
  BridgeGameEventPayload,
  BridgePlayerPayload,
  BridgeServerStatus,
  MinecraftPayload,
} from "../types";
import {
  findLinkByUuid,
  fromSession,
  makeEventId,
  parseData,
  syncMinecraftPresence,
} from "./shared";

const logger = new Logger({ tag: "MinecraftWS" });
const JOIN_SYNC_WINDOW_MS = 5_000;

export const handleChat = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const data = parseData(session.socket, payload, minecraftChatData);
  if (!data) return;

  const { name, content, uuid } = data;

  const messageId = `${session.sessionId}:${Snowflake.generate()}`;
  const chat: BridgeChatPayload = {
    ...fromSession(session, messageId),
    uuid,
    name,
    content,
  };

  await publishBridgeEvent({
    type: "CHAT",
    bridgeId: session.bridgeId,
    sourceId: messageId,
    data: chat,
  });
};

export const handlePlayerEvent = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
  type: "JOIN" | "LEAVE",
) => {
  const player = parseData(session.socket, payload, minecraftPlayerData);
  if (!player) return;

  const { uuid, name } = player;

  if (type === "JOIN") {
    playerJoined(session.bridgeId, {
      uuid,
      name,
      serverId: session.serverId,
    });
    startInventoryWatchIfViewed(session.bridgeId, session.serverId, uuid);
    void deliverPendingEdits(session.bridgeId, session.serverId, uuid).catch(
      (err) => logger.error(`Edit delivery on join failed: ${err}`),
    );
  } else {
    playerLeft(session.bridgeId, uuid);
  }

  const link = await findLinkByUuid(uuid);
  if (link && type === "JOIN") {
    void ensureMember(session.bridgeId, link.userId);
  }
  if (link && type === "LEAVE") {
    void VoiceStateService.leaveFromMinecraft(link.userId.toString());
  }

  void syncMinecraftPresence(
    uuid,
    session.bridgeId,
    session.serverId,
    type,
  ).catch((err) => logger.debug(`presence sync failed: ${err}`));

  const eventId = makeEventId(session, type.toLowerCase(), uuid);
  const data: BridgePlayerPayload = {
    ...fromSession(session, eventId),
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

export const handleGameEvent = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const event = parseData(session.socket, payload, minecraftGameEventData);
  if (!event) return;

  const eventId = makeEventId(session, event.kind, event.uuid);
  const data: BridgeGameEventPayload = {
    ...fromSession(session, eventId),
    uuid: event.uuid,
    name: event.name,
    kind: event.kind,
    message: event.message,
    advancement: event.advancement,
  };

  await publishBridgeEvent({
    type: "GAME_EVENT",
    bridgeId: session.bridgeId,
    sourceId: eventId,
    data,
  });
};

export const handleServerStatus = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const data = parseData(session.socket, payload, minecraftServerStatusData);
  if (!data) return;

  const status: BridgeServerStatus = {
    serverId: session.serverId,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  setServerStatus(session.bridgeId, status);

  await publishBridgeEvent({
    type: "SERVER_STATUS",
    bridgeId: session.bridgeId,
    sourceId: session.sessionId,
    data: { bridgeId: session.bridgeId, serverId: session.serverId, status },
  });
};
