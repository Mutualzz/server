import {
  bridgeBansTable,
  db,
  minecraftLinksTable,
  usersTable,
} from "@mutualzz/database";
import {
  deleteBanIfFullyLifted,
  markBanApplied,
  markBanRemoved,
  moderateOnServers,
  playersForBridge,
  removeMember,
  resolvePlayerName,
} from "@mutualzz/minecraft";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import {
  bridgeInventoryParams,
  bridgeModerationBody,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  requireBridgeAdmin,
  requireSpaceBridge,
} from "@mutualzz/rest/util/Bridges.ts";

export default class SpaceBridgeModerationController {
  static async kickPlayer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      const { minecraftUuid } = parseOrBadRequest(
        bridgeInventoryParams,
        req.params,
      );
      const { reason } = parseOrBadRequest(
        bridgeModerationBody,
        req.body ?? {},
      );

      const bridgeId = bridge.id.toString();
      const online = playersForBridge(bridgeId).find(
        (player) => player.uuid.toLowerCase() === minecraftUuid,
      );
      if (!online) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Player is not online",
        );
      }

      const results = await moderateOnServers(
        bridgeId,
        [online.serverId],
        "kick",
        { uuid: online.uuid, name: online.name, reason },
      );
      res.json({ results });
    } catch (error) {
      next(error);
    }
  }

  static async banPlayer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      const { minecraftUuid } = parseOrBadRequest(
        bridgeInventoryParams,
        req.params,
      );
      const { reason } = parseOrBadRequest(
        bridgeModerationBody,
        req.body ?? {},
      );

      const bridgeId = bridge.id.toString();
      const name = await resolvePlayerName(bridgeId, minecraftUuid);
      if (!name) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Unknown player. They need to have joined a server on this bridge first.",
        );
      }

      const bannedById = BigInt(req.user.id);
      const [ban] = await db
        .insert(bridgeBansTable)
        .values({
          id: BigInt(Snowflake.generate()),
          bridgeId: bridge.id,
          minecraftUuid,
          minecraftName: name,
          reason: reason ?? null,
          bannedById,
        })
        .onConflictDoUpdate({
          target: [bridgeBansTable.bridgeId, bridgeBansTable.minecraftUuid],
          set: {
            minecraftName: name,
            reason: reason ?? null,
            bannedById,
            createdAt: new Date(),
            liftedAt: null,
          },
        })
        .returning({ id: bridgeBansTable.id });

      const link = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.minecraftUuid, minecraftUuid),
        columns: { userId: true },
      });
      if (link) await removeMember(bridge.id, link.userId);

      const results = await moderateOnServers(bridgeId, "all", "ban", {
        uuid: minecraftUuid,
        name,
        reason,
      });

      await markBanApplied(
        ban.id,
        results.filter((result) => result.ok).map((result) => result.serverId),
      );
      res.json({ results });
    } catch (error) {
      next(error);
    }
  }

  static async unbanPlayer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      const { minecraftUuid } = parseOrBadRequest(
        bridgeInventoryParams,
        req.params,
      );

      const [lifted] = await db
        .update(bridgeBansTable)
        .set({ liftedAt: new Date() })
        .where(
          and(
            eq(bridgeBansTable.bridgeId, bridge.id),
            eq(bridgeBansTable.minecraftUuid, minecraftUuid),
            isNull(bridgeBansTable.liftedAt),
          ),
        )
        .returning({
          id: bridgeBansTable.id,
          minecraftName: bridgeBansTable.minecraftName,
        });

      if (!lifted) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Player is not banned",
        );
      }

      const results = await moderateOnServers(
        bridge.id.toString(),
        "all",
        "unban",
        { uuid: minecraftUuid, name: lifted.minecraftName },
      );
      await markBanRemoved(
        lifted.id,
        results.filter((result) => result.ok).map((result) => result.serverId),
      );
      await deleteBanIfFullyLifted(lifted.id);

      res.json({ results });
    } catch (error) {
      next(error);
    }
  }

  static async listBans(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);

      const rows = await db
        .select({
          minecraftUuid: bridgeBansTable.minecraftUuid,
          minecraftName: bridgeBansTable.minecraftName,
          reason: bridgeBansTable.reason,
          createdAt: bridgeBansTable.createdAt,
          bannedById: usersTable.id,
          bannedByUsername: usersTable.username,
          bannedByGlobalName: usersTable.globalName,
        })
        .from(bridgeBansTable)
        .leftJoin(usersTable, eq(usersTable.id, bridgeBansTable.bannedById))
        .where(
          and(
            eq(bridgeBansTable.bridgeId, bridge.id),
            isNull(bridgeBansTable.liftedAt),
          ),
        )
        .orderBy(desc(bridgeBansTable.createdAt))
        .limit(200);

      res.json({
        bans: rows.map((row) => ({
          minecraftUuid: row.minecraftUuid,
          minecraftName: row.minecraftName,
          reason: row.reason,
          createdAt: row.createdAt,
          bannedBy: row.bannedById
            ? {
                id: row.bannedById.toString(),
                username: row.bannedByUsername,
                globalName: row.bannedByGlobalName,
              }
            : null,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
}
