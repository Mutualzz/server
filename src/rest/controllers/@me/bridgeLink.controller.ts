import {
  db,
  minecraftLinkCodesTable,
  minecraftLinksTable,
} from "@mutualzz/database";
import {
  emitMinecraftLinkUpdate,
  ensureMember,
  findOnlineBridgesForUuid,
  generateLinkCode,
  isBridgeOnline,
  removeAllMembershipsForUser,
} from "@mutualzz/minecraft";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import { bridgeLinkCodeBody, bridgeRedeemBody } from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { listAccessibleBridges } from "@mutualzz/rest/util/Bridges.ts";

export default class MeBridgeLinkController {
  static async createLinkCode(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const uid = BigInt(user.id);
      const existing = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.userId, uid),
      });
      if (existing) {
        res.json({
          alreadyLinked: true,
          minecraftUuid: existing.minecraftUuid,
          minecraftName: existing.minecraftName,
        });
        return;
      }

      const accessible = await listAccessibleBridges(uid);
      if (accessible.length === 0) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Join a Mutualzz Minecraft server or open a space bridge before linking",
        );
      }

      const preferredId =
        parseOrBadRequest(bridgeLinkCodeBody, req.body ?? {}).bridgeId || null;

      const preferred = preferredId
        ? accessible.find((b) => b.id.toString() === preferredId)
        : undefined;
      if (preferredId && !preferred) {
        throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
      }

      const bridge =
        (preferred && isBridgeOnline(preferred.id.toString())
          ? preferred
          : null) ??
        accessible.find((b) => isBridgeOnline(b.id.toString())) ??
        null;

      if (!bridge) {
        throw new HttpException(
          HttpStatusCode.Conflict,
          "Minecraft server is not connected to the hub",
        );
      }

      const code = generateLinkCode();

      await db.insert(minecraftLinkCodesTable).values({
        id: BigInt(Snowflake.generate()),
        code,
        userId: uid,
        bridgeId: bridge.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      res.status(HttpStatusCode.Created).json({
        code,
        expiresInSeconds: 600,
        hint: "Run /mzlink <code> in Minecraft on any connected server",
      });
    } catch (error) {
      next(error);
    }
  }

  static async redeemMinecraftCode(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { user } = req;
      const { code } = parseOrBadRequest(bridgeRedeemBody, req.body ?? {});

      const already = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.userId, BigInt(user.id)),
      });
      if (already) {
        throw new HttpException(
          HttpStatusCode.Conflict,
          "Account already linked to Minecraft",
        );
      }

      const row = await db.query.minecraftLinkCodesTable.findFirst({
        where: eq(minecraftLinkCodesTable.code, code),
      });

      if (
        !row ||
        row.usedAt ||
        row.expiresAt.getTime() < Date.now() ||
        !row.minecraftUuid ||
        !row.minecraftName
      ) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Invalid or expired code",
        );
      }

      await db.insert(minecraftLinksTable).values({
        id: BigInt(Snowflake.generate()),
        userId: BigInt(user.id),
        minecraftUuid: row.minecraftUuid,
        minecraftName: row.minecraftName,
        discordId: row.discordId,
      });

      await db
        .update(minecraftLinkCodesTable)
        .set({ usedAt: new Date(), userId: BigInt(user.id) })
        .where(eq(minecraftLinkCodesTable.id, row.id));

      emitMinecraftLinkUpdate(user.id, {
        minecraftUuid: row.minecraftUuid,
        minecraftName: row.minecraftName,
        discordId: row.discordId,
        createdAt: new Date(),
      });

      const bridgeIds = new Set<string>();
      if (row.bridgeId) bridgeIds.add(row.bridgeId.toString());
      for (const online of findOnlineBridgesForUuid(row.minecraftUuid)) {
        bridgeIds.add(online.bridgeId);
      }
      const joinedBridgeIds: string[] = [];
      for (const bridgeId of bridgeIds) {
        const added = await ensureMember(bridgeId, user.id);
        if (added) joinedBridgeIds.push(bridgeId);
      }

      res.json({
        ok: true,
        minecraftUuid: row.minecraftUuid,
        minecraftName: row.minecraftName,
        joinedBridgeIds,
        joinedCount: joinedBridgeIds.length,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getLink(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const link = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.userId, BigInt(user.id)),
      });
      res.json(
        link
          ? {
              minecraftUuid: link.minecraftUuid,
              minecraftName: link.minecraftName,
              discordId: link.discordId,
              createdAt: link.createdAt,
            }
          : null,
      );
    } catch (error) {
      next(error);
    }
  }

  static async unlink(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const link = await db.query.minecraftLinksTable.findFirst({
        where: eq(minecraftLinksTable.userId, BigInt(user.id)),
      });
      if (!link) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "No Minecraft account linked",
        );
      }

      await db
        .delete(minecraftLinksTable)
        .where(eq(minecraftLinksTable.userId, BigInt(user.id)));

      await removeAllMembershipsForUser(user.id);

      emitMinecraftLinkUpdate(user.id, null);

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }
}
