import { db, minecraftInventoriesTable } from "@mutualzz/database";
import { playersForBridge, serializeInventory } from "@mutualzz/minecraft";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  bridgeInventoryParams,
  bridgeKnownPlayersQuery,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, desc, eq, ilike, notInArray, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  requireBridgeAdmin,
  requireSpaceBridge,
} from "@mutualzz/rest/util/Bridges.ts";

export default class SpaceBridgeInventoriesController {
  static async getInventory(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);

      const { minecraftUuid } = parseOrBadRequest(
        bridgeInventoryParams,
        req.params,
      );

      const rows = await db.query.minecraftInventoriesTable.findMany({
        where: and(
          eq(minecraftInventoriesTable.bridgeId, bridge.id),
          eq(minecraftInventoriesTable.minecraftUuid, minecraftUuid),
        ),
      });
      if (rows.length === 0) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "No inventory snapshot for this player",
        );
      }

      res.json(rows.map(serializeInventory));
    } catch (error) {
      next(error);
    }
  }

  static async deleteInventory(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);

      const { minecraftUuid } = parseOrBadRequest(
        bridgeInventoryParams,
        req.params,
      );

      await db
        .delete(minecraftInventoriesTable)
        .where(
          and(
            eq(minecraftInventoriesTable.bridgeId, bridge.id),
            eq(minecraftInventoriesTable.minecraftUuid, minecraftUuid),
          ),
        );

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async listInventories(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      const { limit, offset, q, offline } = bridgeKnownPlayersQuery.parse(
        req.query,
      );

      const bridgeId = bridge.id.toString();
      const onlineUuids = playersForBridge(bridgeId).map((player) =>
        player.uuid.toLowerCase(),
      );
      const pattern = q
        ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        : null;

      const where = and(
        eq(minecraftInventoriesTable.bridgeId, bridge.id),
        offline && onlineUuids.length > 0
          ? notInArray(minecraftInventoriesTable.minecraftUuid, onlineUuids)
          : undefined,
        pattern
          ? ilike(minecraftInventoriesTable.minecraftName, pattern)
          : undefined,
      );

      const lastSeenAt = sql<Date>`max(${minecraftInventoriesTable.capturedAt})`;

      const [rows, [{ total }]] = await Promise.all([
        db
          .select({
            minecraftUuid: minecraftInventoriesTable.minecraftUuid,
            minecraftName: sql<string>`(array_agg(${minecraftInventoriesTable.minecraftName} order by ${minecraftInventoriesTable.capturedAt} desc))[1]`,
            servers: sql<
              string[]
            >`array_agg(${minecraftInventoriesTable.serverId} order by ${minecraftInventoriesTable.capturedAt} desc)`,
            lastSeenAt,
          })
          .from(minecraftInventoriesTable)
          .where(where)
          .groupBy(minecraftInventoriesTable.minecraftUuid)
          .orderBy(desc(lastSeenAt), minecraftInventoriesTable.minecraftUuid)
          .limit(limit + 1)
          .offset(offset),
        db
          .select({
            total: sql<number>`count(distinct ${minecraftInventoriesTable.minecraftUuid})::int`,
          })
          .from(minecraftInventoriesTable)
          .where(where),
      ]);

      const online = new Set(onlineUuids);
      res.json({
        players: rows.slice(0, limit).map((row) => ({
          ...row,
          online: online.has(row.minecraftUuid.toLowerCase()),
        })),
        hasMore: rows.length > limit,
        total,
      });
    } catch (error) {
      next(error);
    }
  }
}
