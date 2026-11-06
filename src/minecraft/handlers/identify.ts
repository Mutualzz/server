import {
  bridgeMinecraftServersTable,
  bridgesTable,
  bridgeTokensTable,
  bridgeVoiceBindingsTable,
  db,
} from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { Snowflake } from "@mutualzz/util";
import { minecraftIdentifyData } from "@mutualzz/validators";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { syncBansForServer } from "../Bans.ts";
import { registerSession, sendToSocket } from "../SessionRegistry";
import { hashBridgeToken } from "../tokens";
import type { MinecraftPayload } from "../types";
import { closeWithError } from "./shared";

const logger = new Logger({ tag: "MinecraftWS" });

export const handleIdentify = async (
  socket: WebSocket,
  payload: MinecraftPayload,
) => {
  const parsed = minecraftIdentifyData.safeParse(payload.d);
  if (!parsed.success) {
    closeWithError(
      socket,
      "missing_credentials",
      "token and serverId are required",
    );
    return;
  }

  const { token, serverId, remoteModeration, remoteInventoryEdit } =
    parsed.data;

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
      remoteInventoryEdit,
      lastSeenAt: new Date(),
    });
  } else {
    await db
      .update(bridgeMinecraftServersTable)
      .set({ lastSeenAt: new Date(), remoteInventoryEdit })
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
    remoteModeration,
    remoteInventoryEdit,
  });

  const voiceRooms = await listVoiceRoomNames(bridgeId, serverId);

  sendToSocket(socket, {
    op: "ready",
    d: { bridgeId, serverId, sessionId, voiceRooms },
  });

  if (remoteModeration) {
    void syncBansForServer(bridgeId, serverId).catch((err) =>
      logger.error(`Ban sync failed for ${bridgeId}/${serverId}: ${err}`),
    );
  }

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
