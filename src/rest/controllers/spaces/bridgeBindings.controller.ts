import {
  bridgeDiscordBindingsTable,
  bridgesTable,
  bridgeVoiceBindingsTable,
  channelsTable,
  db,
} from "@mutualzz/database";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import {
  bridgeBindingParams,
  bridgeDiscordBindBody,
  bridgeVoiceBindBody,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "@mutualzz/rest/util/Validation";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  requireBridgeAdmin,
  requireBridgeFromParams,
} from "@mutualzz/rest/util/Bridges.ts";

export default class BridgeBindingsController {
  static async bindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);
      const { serverId, guildId, channelId } = parseOrBadRequest(
        bridgeDiscordBindBody,
        req.body ?? {},
      );

      const existing = await db.query.bridgeDiscordBindingsTable.findFirst({
        where: and(
          eq(bridgeDiscordBindingsTable.bridgeId, bridge.id),
          eq(bridgeDiscordBindingsTable.serverId, serverId),
        ),
      });

      const names = await DiscordBridgePeer.resolveBindingNames(
        guildId,
        channelId,
      );

      const canAccess = await DiscordBridgePeer.canAccessChannel(
        guildId,
        channelId,
      );
      if (!canAccess) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Discord bot cannot access that channel",
        );
      }

      if (existing) {
        const [updated] = await db
          .update(bridgeDiscordBindingsTable)
          .set({ guildId, channelId, webhookId: null, webhookToken: null })
          .where(eq(bridgeDiscordBindingsTable.id, existing.id))
          .returning();
        void DiscordBridgePeer.reloadBindings();
        res.json({
          id: updated.id.toString(),
          serverId: updated.serverId,
          guildId: updated.guildId,
          channelId: updated.channelId,
          ...names,
        });
        return;
      }

      const [created] = await db
        .insert(bridgeDiscordBindingsTable)
        .values({
          id: BigInt(Snowflake.generate()),
          bridgeId: bridge.id,
          serverId,
          guildId,
          channelId,
        })
        .returning();

      void DiscordBridgePeer.reloadBindings();

      res.status(HttpStatusCode.Created).json({
        id: created.id.toString(),
        serverId: created.serverId,
        guildId: created.guildId,
        channelId: created.channelId,
        ...names,
      });
    } catch (error) {
      next(error);
    }
  }

  static async bindVoice(
    req: Request,
    res: Response,
    next: NextFunction,
    bridgeOverride?: typeof bridgesTable.$inferSelect,
  ) {
    try {
      const bridge = bridgeOverride ?? (await requireBridgeFromParams(req));
      await requireBridgeAdmin(req, bridge);
      const { serverId, channelId, name } = parseOrBadRequest(
        bridgeVoiceBindBody,
        req.body ?? {},
      );
      const spaceId = bridge.spaceId.toString();

      const channel = await db.query.channelsTable.findFirst({
        where: eq(channelsTable.id, BigInt(channelId)),
      });
      if (
        !channel ||
        channel.type !== ChannelType.Voice ||
        channel.spaceId?.toString() !== spaceId
      ) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "channelId must be a voice channel in this bridge's space",
        );
      }

      const existing = await db.query.bridgeVoiceBindingsTable.findFirst({
        where: and(
          eq(bridgeVoiceBindingsTable.bridgeId, bridge.id),
          eq(bridgeVoiceBindingsTable.serverId, serverId),
          eq(bridgeVoiceBindingsTable.name, name),
        ),
      });

      if (existing) {
        const [updated] = await db
          .update(bridgeVoiceBindingsTable)
          .set({
            spaceId: BigInt(spaceId),
            channelId: BigInt(channelId),
          })
          .where(eq(bridgeVoiceBindingsTable.id, existing.id))
          .returning();
        res.json({
          id: updated.id.toString(),
          serverId: updated.serverId,
          name: updated.name,
          spaceId,
          channelId: updated.channelId.toString(),
        });
        return;
      }

      const [created] = await db
        .insert(bridgeVoiceBindingsTable)
        .values({
          id: BigInt(Snowflake.generate()),
          bridgeId: bridge.id,
          serverId,
          name,
          spaceId: BigInt(spaceId),
          channelId: BigInt(channelId),
        })
        .returning();

      res.status(HttpStatusCode.Created).json({
        id: created.id.toString(),
        serverId: created.serverId,
        name: created.name,
        spaceId,
        channelId: created.channelId.toString(),
      });
    } catch (error) {
      next(error);
    }
  }

  static async unbindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);
      const bindingId = BigInt(
        parseOrBadRequest(bridgeBindingParams, req.params).bindingId,
      );
      const existing = await db.query.bridgeDiscordBindingsTable.findFirst({
        where: and(
          eq(bridgeDiscordBindingsTable.id, bindingId),
          eq(bridgeDiscordBindingsTable.bridgeId, bridge.id),
        ),
      });
      if (!existing) {
        throw new HttpException(HttpStatusCode.NotFound, "Binding not found");
      }

      await db
        .delete(bridgeDiscordBindingsTable)
        .where(eq(bridgeDiscordBindingsTable.id, existing.id));

      void DiscordBridgePeer.reloadBindings();
      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async unbindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await requireBridgeFromParams(req);
      await requireBridgeAdmin(req, bridge);
      const bindingId = BigInt(
        parseOrBadRequest(bridgeBindingParams, req.params).bindingId,
      );
      const existing = await db.query.bridgeVoiceBindingsTable.findFirst({
        where: and(
          eq(bridgeVoiceBindingsTable.id, bindingId),
          eq(bridgeVoiceBindingsTable.bridgeId, bridge.id),
        ),
      });
      if (!existing) {
        throw new HttpException(HttpStatusCode.NotFound, "Binding not found");
      }

      await db
        .delete(bridgeVoiceBindingsTable)
        .where(eq(bridgeVoiceBindingsTable.id, existing.id));

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }
}
