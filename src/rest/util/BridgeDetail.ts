import {
  bridgeDiscordBindingsTable,
  bridgeMinecraftServersTable,
  bridgeReadStatesTable,
  bridgesTable,
  bridgeTokensTable,
  bridgeVoiceBindingsTable,
  db,
} from "@mutualzz/database";
import {
  connectedServerIds,
  isBridgeOnline,
  linkedUsersByMinecraftUuids,
  moderationServerIds,
  playersForBridge,
  serverStatusesForBridge,
  type BridgeRole,
} from "@mutualzz/minecraft";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { isUnread, serializeBridge } from "@mutualzz/rest/util/Bridges.ts";

export class BridgesDetailHandler {
  static async get(
    req: Request,
    res: Response,
    next: NextFunction,
    bridge: typeof bridgesTable.$inferSelect,
    role: BridgeRole,
  ) {
    try {
      const { user } = req;
      const servers = await db.query.bridgeMinecraftServersTable.findMany({
        where: eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
      });
      const bindings =
        role === "admin"
          ? await db.query.bridgeDiscordBindingsTable.findMany({
              where: eq(bridgeDiscordBindingsTable.bridgeId, bridge.id),
            })
          : [];
      const voiceBindings =
        role === "admin"
          ? await db.query.bridgeVoiceBindingsTable.findMany({
              where: eq(bridgeVoiceBindingsTable.bridgeId, bridge.id),
            })
          : [];
      const tokens =
        role === "admin"
          ? await db.query.bridgeTokensTable.findMany({
              where: and(
                eq(bridgeTokensTable.bridgeId, bridge.id),
                isNull(bridgeTokensTable.revokedAt),
              ),
            })
          : [];

      const onlinePlayers = playersForBridge(bridge.id.toString());
      const linkedByUuid = await linkedUsersByMinecraftUuids(
        onlinePlayers.map((p) => p.uuid),
      );

      const readState = await db.query.bridgeReadStatesTable.findFirst({
        where: and(
          eq(bridgeReadStatesTable.userId, BigInt(user.id)),
          eq(bridgeReadStatesTable.bridgeId, bridge.id),
        ),
      });
      const lastAckedId = readState?.lastAckedId ?? "";

      const discordBindings = await Promise.all(
        bindings.map(async (b) => {
          const names = await DiscordBridgePeer.resolveBindingNames(
            b.guildId,
            b.channelId,
          );
          return {
            id: b.id.toString(),
            serverId: b.serverId,
            guildId: b.guildId,
            channelId: b.channelId,
            hasWebhook: Boolean(b.webhookId && b.webhookToken),
            ...names,
          };
        }),
      );

      res.json({
        ...serializeBridge(bridge, {
          role,
          lastAckedId: lastAckedId.length > 0 ? lastAckedId : null,
          unread: isUnread(bridge.lastMessageId, lastAckedId),
        }),
        hubConnected: isBridgeOnline(bridge.id.toString()),
        connectedServers: connectedServerIds(bridge.id.toString()),
        serverStatuses: serverStatusesForBridge(bridge.id.toString()),
        moderationServers: moderationServerIds(bridge.id.toString()),

        onlinePlayers: onlinePlayers.map((p) => {
          const link =
            linkedByUuid.get(p.uuid.toLowerCase()) ??
            linkedByUuid.get(p.uuid.toLowerCase().replace(/-/g, ""));
          return {
            ...p,
            linkedUser: link
              ? {
                  id: link.userId,
                  username: link.username,
                  globalName: link.globalName,
                  avatar: link.avatar,
                }
              : null,
          };
        }),
        servers: servers.map((s) => ({
          id: s.id.toString(),
          serverId: s.serverId,
          displayName: s.displayName,
          lastSeenAt: s.lastSeenAt ?? null,
        })),
        discordBindings,
        voiceBindings: voiceBindings.map((b) => ({
          id: b.id.toString(),
          serverId: b.serverId,
          name: b.name,
          spaceId: b.spaceId.toString(),
          channelId: b.channelId.toString(),
        })),
        tokens: tokens.map((t) => ({
          id: t.id.toString(),
          name: t.name,
          tokenPrefix: t.tokenPrefix,
          lastUsedAt: t.lastUsedAt,
          createdAt: t.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
}
