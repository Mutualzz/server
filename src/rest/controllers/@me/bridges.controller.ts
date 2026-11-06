import {
  bridgeMembersTable,
  bridgeMinecraftServersTable,
  bridgeReadStatesTable,
  bridgesTable,
  db,
  minecraftInventoriesTable,
  minecraftLinksTable,
  spaceMembersTable,
} from "@mutualzz/database";
import {
  connectedServerIds,
  isBridgeOnline,
  linkedUsersByMinecraftUuids,
  listBridgeMessages,
  playersForBridge,
  publishBridgeEvent,
  removeMember,
  serializeInventory,
  type BridgeChatPayload,
} from "@mutualzz/minecraft";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import {
  bridgeAckBody,
  bridgeChatBody,
  bridgeIdParams,
  bridgeMessagesListQuery,
  bridgesListQuery,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  isUnread,
  requireAccessibleBridge,
  requireMyMinecraftLink,
  roleForBridge,
  sanitizeServerId,
  serializeBridge,
} from "@mutualzz/rest/util/Bridges.ts";
import { BridgesDetailHandler } from "@mutualzz/rest/util/BridgeDetail.ts";

export default class MeBridgesController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const uid = BigInt(user.id);
      const includeArchived =
        bridgesListQuery.parse(req.query).archived === true;

      const [memberships, spaceMemberships] = await Promise.all([
        db.query.bridgeMembersTable.findMany({
          where: eq(bridgeMembersTable.userId, uid),
        }),
        db.query.spaceMembersTable.findMany({
          where: eq(spaceMembersTable.userId, uid),
        }),
      ]);

      const memberBridgeIds = memberships.map((m) => m.bridgeId);
      const spaceIds = spaceMemberships.map((m) => m.spaceId);

      const accessWhere = or(
        memberBridgeIds.length > 0
          ? inArray(bridgesTable.id, memberBridgeIds)
          : undefined,
        spaceIds.length > 0
          ? inArray(bridgesTable.spaceId, spaceIds)
          : undefined,
      );

      if (!accessWhere) {
        res.json([]);
        return;
      }

      const bridges = await db.query.bridgesTable.findMany({
        where: and(
          accessWhere,
          includeArchived ? undefined : eq(bridgesTable.status, 0),
        ),
        orderBy: [desc(bridgesTable.createdAt)],
      });

      const bridgeIds = bridges.map((b) => b.id);
      const readStates =
        bridgeIds.length === 0
          ? []
          : await db.query.bridgeReadStatesTable.findMany({
              where: and(
                eq(bridgeReadStatesTable.userId, uid),
                inArray(bridgeReadStatesTable.bridgeId, bridgeIds),
              ),
            });
      const lastAckedByBridge = new Map(
        readStates.map((s) => [s.bridgeId.toString(), s.lastAckedId]),
      );

      res.json(
        await Promise.all(
          bridges.map(async (bridge) => {
            const lastAckedId =
              lastAckedByBridge.get(bridge.id.toString()) ?? "";
            const role = await roleForBridge(bridge, uid);
            return serializeBridge(bridge, {
              role,
              hubConnected: isBridgeOnline(bridge.id.toString()),
              onlineCount: playersForBridge(bridge.id.toString()).length,
              lastAckedId: lastAckedId.length > 0 ? lastAckedId : null,
              unread: isUnread(bridge.lastMessageId, lastAckedId),
            });
          }),
        ),
      );
    } catch (error) {
      next(error);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { bridge, role } = await requireAccessibleBridge(req);
      return BridgesDetailHandler.get(req, res, next, bridge, role);
    } catch (error) {
      next(error);
    }
  }

  static async ack(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge } = await requireAccessibleBridge(req);
      const { lastAckedId } = parseOrBadRequest(bridgeAckBody, req.body ?? {});

      await db
        .insert(bridgeReadStatesTable)
        .values({
          userId: BigInt(user.id),
          bridgeId: bridge.id,
          lastAckedId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            bridgeReadStatesTable.userId,
            bridgeReadStatesTable.bridgeId,
          ],
          set: {
            lastAckedId,
            updatedAt: new Date(),
          },
        });

      res.json({
        bridgeId: bridge.id.toString(),
        lastAckedId,
        unread: isUnread(bridge.lastMessageId, lastAckedId),
      });
    } catch (error) {
      next(error);
    }
  }

  static async listMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const { bridge } = await requireAccessibleBridge(req);
      const { limit, before } = bridgeMessagesListQuery.parse(req.query);

      const messages = await listBridgeMessages(bridge.id.toString(), {
        limit,
        before,
      });

      const linkedByUuid = await linkedUsersByMinecraftUuids(
        messages.map((m) => m.uuid).filter((u): u is string => Boolean(u)),
      );

      res.json(
        messages.map((m) => {
          const link = m.uuid
            ? (linkedByUuid.get(m.uuid.toLowerCase()) ??
              linkedByUuid.get(m.uuid.toLowerCase().replace(/-/g, "")))
            : undefined;
          return {
            ...m,
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
      );
    } catch (error) {
      next(error);
    }
  }

  static async myInventories(req: Request, res: Response, next: NextFunction) {
    try {
      const { bridge } = await requireAccessibleBridge(req);

      const link = await requireMyMinecraftLink(req);

      const rows = await db.query.minecraftInventoriesTable.findMany({
        where: and(
          eq(minecraftInventoriesTable.bridgeId, bridge.id),
          eq(minecraftInventoriesTable.minecraftUuid, link.minecraftUuid),
        ),
      });

      res.json(rows.map(serializeInventory));
    } catch (error) {
      next(error);
    }
  }

  static async leave(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const bridgeId = BigInt(
        parseOrBadRequest(bridgeIdParams, req.params).bridgeId,
      );
      const bridge = await db.query.bridgesTable.findFirst({
        where: eq(bridgesTable.id, bridgeId),
      });
      if (!bridge) {
        throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
      }

      const removed = await removeMember(bridgeId, user.id);
      if (!removed) {
        throw new HttpException(HttpStatusCode.NotFound, "Not a bridge member");
      }

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async sendChat(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge } = await requireAccessibleBridge(req);
      const body = parseOrBadRequest(bridgeChatBody, req.body ?? {});
      const { content } = body;

      const connected = connectedServerIds(bridge.id.toString());
      const servers = await db.query.bridgeMinecraftServersTable.findMany({
        where: eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
      });
      const serverId = sanitizeServerId(
        body.serverId ?? connected[0] ?? servers[0]?.serverId ?? "",
      );
      if (!serverId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId is required",
        );
      }

      const displayName =
        user.globalName?.trim() || user.username.trim() || "Mutualzz";

      const linked = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.userId, BigInt(user.id)),
      });

      const sourceId = `app:${Snowflake.generate()}`;
      const data: BridgeChatPayload = {
        bridgeId: bridge.id.toString(),
        serverId,
        source: "app",
        sourceId,
        name: displayName,
        content,
        userId: user.id.toString(),
        uuid: linked?.minecraftUuid,
      };

      await publishBridgeEvent({
        type: "CHAT",
        bridgeId: data.bridgeId,
        sourceId,
        data,
      });

      res.status(HttpStatusCode.Created).json({
        id: sourceId,
        bridgeId: data.bridgeId,
        serverId: data.serverId,
        source: data.source,
        name: data.name,
        content: data.content,
        userId: data.userId,
        uuid: data.uuid,
        at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }

  static async discordStatus(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      res.json({
        botInviteUrl: DiscordBridgePeer.getInviteUrl(),
      });
    } catch (error) {
      next(error);
    }
  }
}
