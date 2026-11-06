import {
  bridgeMinecraftServersTable,
  db,
  minecraftLinksTable,
} from "@mutualzz/database";
import { Snowflake } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { PresenceService } from "../../gateway/presence/Presence.service.ts";
import { customServerName } from "../serverNames.ts";
import { sendToSocket, type MinecraftSession } from "../SessionRegistry";
import type { MinecraftPayload } from "../types";

export const findLinkByUuid = (minecraftUuid: string) =>
  db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, minecraftUuid),
  });

export const makeEventId = (
  session: MinecraftSession,
  kind: string,
  uuid: string,
) => `${session.sessionId}:${kind}:${uuid}:${Snowflake.generate()}`;

export const fromSession = (session: MinecraftSession, sourceId: string) => ({
  bridgeId: session.bridgeId,
  serverId: session.serverId,
  source: "minecraft" as const,
  sourceId,
});

const resolveBridgePresenceLabels = async (
  bridgeId: string,
  serverId: string,
) => {
  const server = await db.query.bridgeMinecraftServersTable.findFirst({
    where: and(
      eq(bridgeMinecraftServersTable.bridgeId, BigInt(bridgeId)),
      eq(bridgeMinecraftServersTable.serverId, serverId),
    ),
    columns: { displayName: true },
  });

  return { serverName: customServerName(serverId, server?.displayName) };
};

export const syncMinecraftPresence = async (
  uuid: string,
  bridgeId: string,
  serverId: string,
  type: "JOIN" | "LEAVE",
) => {
  const link = await findLinkByUuid(uuid);
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

export const closeWithError = (
  socket: WebSocket,
  code: string,
  message: string,
  closeCode = 4001,
) => {
  sendToSocket(socket, { op: "error", d: { code, message } });
  socket.close(closeCode, message);
};

export const parseData = <T extends z.ZodType>(
  socket: WebSocket,
  payload: MinecraftPayload,
  schema: T,
): z.output<T> | null => {
  const result = schema.safeParse(payload.d);
  if (result.success) return result.data;

  sendToSocket(socket, {
    op: "error",
    d: {
      code: "invalid_payload",
      message: `Invalid ${String(payload.op)} payload`,
    },
  });
  return null;
};
