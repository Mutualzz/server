import {
  bridgeMembersTable,
  bridgeMinecraftServersTable,
  bridgesTable,
  bridgeTokensTable,
  db,
  minecraftLinksTable,
  spaceMembersTable,
  usersTable,
} from "@mutualzz/database";
import {
  AppBridgePeer,
  buildPluginConfig,
  generateBridgeToken,
  playersForBridge,
} from "@mutualzz/minecraft";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { getSpace, requireSpacePermissions, Snowflake } from "@mutualzz/util";
import {
  bridgeCreateBody,
  bridgeMembersListQuery,
  bridgeSpaceParams,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, desc, eq, ilike, notExists, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  requireBridgeAdmin,
  requireBridgeFromParams,
  requireSpaceBridge,
  serializeBridge,
} from "@mutualzz/rest/util/Bridges.ts";
import { BridgesDetailHandler } from "@mutualzz/rest/util/BridgeDetail.ts";
import BridgeBindingsController from "@mutualzz/rest/controllers/spaces/bridgeBindings.controller.ts";
import BridgeManageController from "@mutualzz/rest/controllers/spaces/bridgeManage.controller.ts";

export default class SpaceBridgeController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      return BridgesDetailHandler.get(req, res, next, bridge, "admin");
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = parseOrBadRequest(bridgeSpaceParams, req.params);
      const body = parseOrBadRequest(bridgeCreateBody, req.body ?? {});
      const space = await getSpace(spaceId);
      if (!space) {
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");
      }

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      const existing = await db.query.bridgesTable.findFirst({
        where: eq(bridgesTable.spaceId, BigInt(spaceId)),
      });
      if (existing) {
        throw new HttpException(
          HttpStatusCode.Conflict,
          "This space already has a Minecraft bridge",
        );
      }

      const name = body.name ?? `${space.name} Bridge`.trim().slice(0, 64);
      const serverId = body.serverId ?? "";

      const bridgeId = BigInt(Snowflake.generate());
      const [bridge] = await db
        .insert(bridgesTable)
        .values({
          id: bridgeId,
          spaceId: BigInt(spaceId),
          createdById: BigInt(user.id),
          name,
        })
        .returning();

      if (serverId) {
        await db.insert(bridgeMinecraftServersTable).values({
          id: BigInt(Snowflake.generate()),
          bridgeId,
          serverId,
          displayName: body.displayName || serverId,
        });
      }

      const token = generateBridgeToken();
      await db.insert(bridgeTokensTable).values({
        id: BigInt(Snowflake.generate()),
        bridgeId,
        tokenHash: token.tokenHash,
        tokenPrefix: token.tokenPrefix,
        name: "default",
      });

      res.status(HttpStatusCode.Created).json({
        ...serializeBridge(bridge, { role: "admin" as const }),
        token: token.plaintext,
        pluginConfig: buildPluginConfig(token.plaintext, serverId || undefined),
      });

      void AppBridgePeer.reloadBridges();
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeManageController.update(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async updateServer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeManageController.updateServer(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async rotateToken(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeManageController.rotateToken(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async bindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeBindingsController.bindDiscord(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async unbindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeBindingsController.unbindDiscord(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async bindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeBindingsController.bindVoice(req, res, next, bridge);
    } catch (error) {
      next(error);
    }
  }

  static async unbindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeBindingsController.unbindVoice(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async listMembers(
    req: Request,
    res: Response,
    next: NextFunction,
    bridgeOverride?: typeof bridgesTable.$inferSelect,
  ) {
    try {
      const bridge = bridgeOverride ?? (await requireBridgeFromParams(req));
      await requireBridgeAdmin(req, bridge);
      const { limit, offset, q } = bridgeMembersListQuery.parse(req.query);

      const pattern = q
        ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        : null;

      const rows = await db
        .select({
          userId: bridgeMembersTable.userId,
          joinedAt: bridgeMembersTable.joinedAt,
          username: usersTable.username,
          globalName: usersTable.globalName,
          avatar: usersTable.avatar,
          minecraftUuid: minecraftLinksTable.minecraftUuid,
          minecraftName: minecraftLinksTable.minecraftName,
        })
        .from(bridgeMembersTable)
        .innerJoin(usersTable, eq(usersTable.id, bridgeMembersTable.userId))
        .leftJoin(
          minecraftLinksTable,
          eq(minecraftLinksTable.userId, bridgeMembersTable.userId),
        )
        .where(
          and(
            eq(bridgeMembersTable.bridgeId, bridge.id),
            notExists(
              db
                .select({ userId: spaceMembersTable.userId })
                .from(spaceMembersTable)
                .where(
                  and(
                    eq(spaceMembersTable.spaceId, bridge.spaceId),
                    eq(spaceMembersTable.userId, bridgeMembersTable.userId),
                  ),
                ),
            ),
            pattern
              ? or(
                  ilike(usersTable.username, pattern),
                  ilike(usersTable.globalName, pattern),
                  ilike(minecraftLinksTable.minecraftName, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(bridgeMembersTable.joinedAt),
          desc(bridgeMembersTable.userId),
        )
        .limit(limit + 1)
        .offset(offset);

      const onlineUuids = new Set(
        playersForBridge(bridge.id.toString()).map((player) =>
          player.uuid.toLowerCase().replace(/-/g, ""),
        ),
      );

      res.json({
        members: rows.slice(0, limit).map((row) => ({
          userId: row.userId.toString(),
          role: "member" as const,
          username: row.username,
          globalName: row.globalName,
          avatar: row.avatar,
          joinedAt: row.joinedAt,
          online: Boolean(
            row.minecraftUuid &&
            onlineUuids.has(row.minecraftUuid.toLowerCase().replace(/-/g, "")),
          ),
          minecraftUuid: row.minecraftUuid,
          minecraftName: row.minecraftName,
        })),
        hasMore: rows.length > limit,
      });
    } catch (error) {
      next(error);
    }
  }

  static async kickMember(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeManageController.kickMember(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireSpaceBridge(String(req.params.spaceId));
      await requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return BridgeManageController.delete(req, res, next);
    } catch (error) {
      next(error);
    }
  }
}
