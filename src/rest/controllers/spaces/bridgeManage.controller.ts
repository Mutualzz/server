import {
  bridgeMinecraftServersTable,
  bridgesTable,
  bridgeTokensTable,
  db,
  minecraftLinksTable,
} from "@mutualzz/database";
import {
  AppBridgePeer,
  buildPluginConfig,
  customServerName,
  generateBridgeToken,
  playersForBridge,
} from "@mutualzz/minecraft";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import {
  bridgeRotateTokenBody,
  bridgeServerParams,
  bridgeServerUpdateBody,
  bridgeUpdateBody,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  requireBridgeAdmin,
  requireBridgeFromParams,
  serializeBridge,
} from "@mutualzz/rest/util/Bridges.ts";

export default class BridgeManageController {
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);
      const body = parseOrBadRequest(bridgeUpdateBody, req.body ?? {});
      const patch: { name?: string; status?: number } = {};
      if (body.name != null) patch.name = body.name;
      if (body.status != null) patch.status = body.status;

      const [updated] = await db
        .update(bridgesTable)
        .set(patch)
        .where(eq(bridgesTable.id, bridge.id))
        .returning();

      AppBridgePeer.emitBridgeUpdate(updated.id.toString(), {
        id: updated.id.toString(),
        name: updated.name,
        status: updated.status,
      });

      if (patch.status !== undefined) {
        void AppBridgePeer.reloadBridges();
        void DiscordBridgePeer.reloadBindings();
      }

      res.json(serializeBridge(updated));
    } catch (error) {
      next(error);
    }
  }

  static async updateServer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);
      const { serverId } = parseOrBadRequest(bridgeServerParams, req.params);
      const { displayName } = parseOrBadRequest(
        bridgeServerUpdateBody,
        req.body ?? {},
      );

      const existing = await db.query.bridgeMinecraftServersTable.findFirst({
        where: and(
          eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
          eq(bridgeMinecraftServersTable.serverId, serverId),
        ),
      });

      if (!existing) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Minecraft server not found on this bridge",
        );
      }

      const [updated] = await db
        .update(bridgeMinecraftServersTable)
        .set({ displayName })
        .where(
          and(
            eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
            eq(bridgeMinecraftServersTable.serverId, serverId),
          ),
        )
        .returning();

      const bridgeId = bridge.id.toString();
      const presenceServerName = customServerName(serverId, displayName);

      const onlineOnServer = playersForBridge(bridgeId).filter(
        (p) => p.serverId === serverId,
      );

      for (const player of onlineOnServer) {
        const link = await db.query.minecraftLinksTable.findFirst({
          where: eq(minecraftLinksTable.minecraftUuid, player.uuid),
        });
        if (!link) continue;
        void PresenceService.setMinecraftBridgeActivity(
          link.userId.toString(),
          {
            bridgeId,
            serverName: presenceServerName,
          },
        ).catch(() => null);
      }

      res.json({
        id: updated.id.toString(),
        serverId: updated.serverId,
        displayName: updated.displayName,
        lastSeenAt: updated.lastSeenAt,
      });
    } catch (error) {
      next(error);
    }
  }

  static async rotateToken(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);

      await db
        .update(bridgeTokensTable)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(bridgeTokensTable.bridgeId, bridge.id),
            isNull(bridgeTokensTable.revokedAt),
          ),
        );

      const token = generateBridgeToken();
      await db.insert(bridgeTokensTable).values({
        id: BigInt(Snowflake.generate()),
        bridgeId: bridge.id,
        tokenHash: token.tokenHash,
        tokenPrefix: token.tokenPrefix,
        name: "default",
      });

      const { serverId } = parseOrBadRequest(
        bridgeRotateTokenBody,
        req.body ?? {},
      );

      res.json({
        token: token.plaintext,
        pluginConfig: buildPluginConfig(token.plaintext, serverId || undefined),
      });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);

      await db.delete(bridgesTable).where(eq(bridgesTable.id, bridge.id));

      void DiscordBridgePeer.reloadBindings();
      void AppBridgePeer.reloadBridges();

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }
}
