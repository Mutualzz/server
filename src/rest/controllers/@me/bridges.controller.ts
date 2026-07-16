import {
  bridgeDiscordBindingsTable,
  bridgeMembersTable,
  bridgeMinecraftServersTable,
  bridgeReadStatesTable,
  bridgesTable,
  bridgeTokensTable,
  bridgeVoiceBindingsTable,
  channelsTable,
  db,
  minecraftLinkCodesTable,
  minecraftLinksTable,
  spaceMembersTable,
  usersTable,
} from "@mutualzz/database";
import {
  AppBridgePeer,
  buildPluginConfig,
  connectedServerIds,
  emitMinecraftLinkUpdate,
  ensureMember,
  findOnlineBridgesForUuid,
  generateBridgeToken,
  generateLinkCode,
  isBridgeMember,
  isBridgeOnline,
  linkedUsersByMinecraftUuids,
  listBridgeMessages,
  playersForBridge,
  publishBridgeEvent,
  removeAllMembershipsForUser,
  removeMember,
  userCanManageBridge,
  type BridgeChatPayload,
  type BridgeRole,
} from "@mutualzz/minecraft";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  getSpace,
  requireSpacePermissions,
  Snowflake,
} from "@mutualzz/util";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const serializeBridge = (
  bridge: typeof bridgesTable.$inferSelect,
  extras?: Record<string, unknown>,
) => ({
  id: bridge.id.toString(),
  spaceId: bridge.spaceId.toString(),
  name: bridge.name,
  status: bridge.status,
  lastMessageId: bridge.lastMessageId ?? null,
  createdAt: bridge.createdAt,
  updatedAt: bridge.updatedAt,
  ...extras,
});

const isUnread = (
  lastMessageId: string | null | undefined,
  lastAckedId: string | null | undefined,
) => Boolean(lastMessageId && lastMessageId !== (lastAckedId ?? ""));

const roleForBridge = async (
  bridge: typeof bridgesTable.$inferSelect,
  userId: string | bigint,
): Promise<BridgeRole | null> => {
  if (await userCanManageBridge(userId, bridge)) return "admin";
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  const spaceMember = await db.query.spaceMembersTable.findFirst({
    where: and(
      eq(spaceMembersTable.spaceId, bridge.spaceId),
      eq(spaceMembersTable.userId, uid),
    ),
  });
  if (spaceMember) return "member";
  if (await isBridgeMember(bridge.id, uid)) return "member";
  return null;
};

export class SpaceBridgeController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const spaceId = String(req.params.spaceId);
      const bridge = await SpaceBridgeController.requireSpaceBridge(spaceId);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      return BridgesDetailHandler.get(req, res, next, bridge, "admin");
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const spaceId = String(req.params.spaceId);
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

      const name = String(req.body?.name ?? `${space.name} Bridge`).trim();
      if (!name || name.length > 64) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Name must be 1–64 characters",
        );
      }

      const serverId = String(req.body?.serverId ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");

      if (req.body?.serverId != null && !serverId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId must be letters, numbers, _ or -",
        );
      }

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
          displayName: String(req.body?.displayName ?? serverId),
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
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.update(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async updateServer(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.updateServer(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async rotateToken(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.rotateToken(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async bindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.bindDiscord(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async unbindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.unbindDiscord(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async bindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.bindVoice(req, res, next, bridge);
    } catch (error) {
      next(error);
    }
  }

  static async unbindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.unbindVoice(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async listMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.listMembers(req, res, next, bridge);
    } catch (error) {
      next(error);
    }
  }

  static async kickMember(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.kickMember(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await SpaceBridgeController.requireSpaceBridge(
        String(req.params.spaceId),
      );
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      req.params.bridgeId = bridge.id.toString();
      return MeBridgesController.delete(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  static async requireSpaceBridge(spaceId: string) {
    const bridge = await db.query.bridgesTable.findFirst({
      where: eq(bridgesTable.spaceId, BigInt(spaceId)),
    });
    if (!bridge) {
      throw new HttpException(
        HttpStatusCode.NotFound,
        "No Minecraft bridge for this space",
      );
    }
    return bridge;
  }

  static async requireBridgeAdmin(
    req: Request,
    bridge: typeof bridgesTable.$inferSelect,
  ) {
    if (!(await userCanManageBridge(req.user.id, bridge))) {
      throw new HttpException(
        HttpStatusCode.Forbidden,
        "Missing Manage Space permission",
      );
    }
  }
}

export class MeBridgesController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const uid = BigInt(user.id);
      const includeArchived =
        req.query.archived === "1" || req.query.archived === "true";

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
      const { bridge, role } =
        await MeBridgesController.requireAccessibleBridge(req);
      return BridgesDetailHandler.get(req, res, next, bridge, role);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const patch: { name?: string; status?: number } = {};

      if (req.body?.name != null) {
        const name = String(req.body.name).trim();
        if (!name || name.length > 64) {
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Name must be 1–64 characters",
          );
        }
        patch.name = name;
      }

      if (req.body?.status != null) {
        const status = Number(req.body.status);
        if (status !== 0 && status !== 1) {
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "status must be 0 (active) or 1 (archived)",
          );
        }
        patch.status = status;
      }

      if (patch.name === undefined && patch.status === undefined) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Provide name and/or status",
        );
      }

      const [updated] = await db
        .update(bridgesTable)
        .set(patch)
        .where(eq(bridgesTable.id, bridge.id))
        .returning();

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
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const serverId = String(req.params.serverId ?? "").trim();
      const displayName = String(req.body?.displayName ?? "").trim();

      if (!serverId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId is required",
        );
      }

      if (!displayName || displayName.length > 64) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "displayName must be 1–64 characters",
        );
      }

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
      const presenceServerName =
        displayName.toLowerCase() !== serverId.toLowerCase()
          ? displayName
          : null;

      const onlineOnServer = playersForBridge(bridgeId).filter(
        (p) => p.serverId === serverId,
      );

      for (const player of onlineOnServer) {
        const link = await db.query.minecraftLinksTable.findFirst({
          where: eq(minecraftLinksTable.minecraftUuid, player.uuid),
        });
        if (!link) continue;
        void PresenceService.setMinecraftBridgeActivity(link.userId.toString(), {
          bridgeId,
          serverName: presenceServerName,
        }).catch(() => null);
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

  static async ack(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge } = await MeBridgesController.requireAccessibleBridge(req);
      const lastAckedId = String(req.body?.lastAckedId ?? "").trim();
      if (!lastAckedId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "lastAckedId is required",
        );
      }

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
      const { bridge } = await MeBridgesController.requireAccessibleBridge(req);
      const limitRaw = Number(req.query.limit);
      const before =
        typeof req.query.before === "string" ? req.query.before : undefined;

      const messages = await listBridgeMessages(bridge.id.toString(), {
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
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

  static async rotateToken(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);

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

      const serverId = String(req.body?.serverId ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");

      res.json({
        token: token.plaintext,
        pluginConfig: buildPluginConfig(token.plaintext, serverId || undefined),
      });
    } catch (error) {
      next(error);
    }
  }

  static async bindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const serverId = String(req.body?.serverId ?? "").trim();
      const guildId = String(req.body?.guildId ?? "").trim();
      const channelId = String(req.body?.channelId ?? "").trim();

      if (!serverId || !guildId || !channelId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId, guildId, and channelId are required",
        );
      }

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
      const bridge =
        bridgeOverride ??
        (await MeBridgesController.requireBridgeFromParams(req));
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const serverId = String(req.body?.serverId ?? "").trim();
      const channelId = String(req.body?.channelId ?? "").trim();
      const nameRaw = String(req.body?.name ?? "default").trim().toLowerCase();
      const name = nameRaw.replace(/[^a-z0-9_-]/g, "") || "default";
      const spaceId = bridge.spaceId.toString();

      if (!serverId || !channelId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId and channelId are required",
        );
      }

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
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const bindingId = BigInt(String(req.params.bindingId));
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
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const bindingId = BigInt(String(req.params.bindingId));
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

      const accessible = await MeBridgesController.listAccessibleBridges(uid);
      if (accessible.length === 0) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Join a Mutualzz Minecraft server or open a space bridge before linking",
        );
      }

      const preferredId =
        req.body?.bridgeId != null && String(req.body.bridgeId).trim() !== ""
          ? String(req.body.bridgeId)
          : null;

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
      const code = String(req.body?.code ?? "")
        .trim()
        .toUpperCase();
      if (!code) {
        throw new HttpException(HttpStatusCode.BadRequest, "code is required");
      }

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

  static async leave(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const bridgeId = BigInt(String(req.params.bridgeId));
      const bridge = await db.query.bridgesTable.findFirst({
        where: eq(bridgesTable.id, bridgeId),
      });
      if (!bridge) {
        throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
      }

      const removed = await removeMember(bridgeId, user.id);
      if (!removed) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Not a bridge member",
        );
      }

      res.status(HttpStatusCode.NoContent).send();
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
      const bridge =
        bridgeOverride ??
        (await MeBridgesController.requireBridgeFromParams(req));
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);

      const [spaceMemberRows, bridgeMemberRows] = await Promise.all([
        db.query.spaceMembersTable.findMany({
          where: eq(spaceMembersTable.spaceId, bridge.spaceId),
        }),
        db.query.bridgeMembersTable.findMany({
          where: eq(bridgeMembersTable.bridgeId, bridge.id),
        }),
      ]);

      const userIds = new Set<bigint>();
      for (const m of spaceMemberRows) userIds.add(m.userId);
      for (const m of bridgeMemberRows) userIds.add(m.userId);

      const uniqueIds = [...userIds];
      const users =
        uniqueIds.length === 0
          ? []
          : await db.query.usersTable.findMany({
              where: inArray(usersTable.id, uniqueIds),
            });
      const usersById = new Map(users.map((u) => [u.id.toString(), u]));

      const links =
        uniqueIds.length === 0
          ? []
          : await db.query.minecraftLinksTable.findMany({
              where: inArray(minecraftLinksTable.userId, uniqueIds),
            });
      const linksByUser = new Map(links.map((l) => [l.userId.toString(), l]));

      const onlinePlayers = playersForBridge(bridge.id.toString());
      const onlineUuids = new Set(
        onlinePlayers.map((p) => p.uuid.toLowerCase()),
      );
      const onlineUuidsCompact = new Set(
        onlinePlayers.map((p) => p.uuid.toLowerCase().replace(/-/g, "")),
      );

      const isOnline = (uuid?: string | null) => {
        if (!uuid) return false;
        const lower = uuid.toLowerCase();
        return (
          onlineUuids.has(lower) ||
          onlineUuidsCompact.has(lower.replace(/-/g, ""))
        );
      };

      const joinedAtByUser = new Map(
        bridgeMemberRows.map((m) => [m.userId.toString(), m.joinedAt]),
      );

      const serializeMember = async (userId: bigint) => {
        const u = usersById.get(userId.toString());
        const link = linksByUser.get(userId.toString());
        const role = (await userCanManageBridge(userId, bridge))
          ? "admin"
          : "member";
        return {
          userId: userId.toString(),
          role,
          username: u?.username ?? "Unknown",
          globalName: u?.globalName ?? null,
          avatar: u?.avatar ?? null,
          joinedAt:
            joinedAtByUser.get(userId.toString()) ??
            spaceMemberRows.find((m) => m.userId === userId)?.joinedAt ??
            bridge.createdAt,
          online: isOnline(link?.minecraftUuid),
          minecraftUuid: link?.minecraftUuid ?? null,
          minecraftName: link?.minecraftName ?? null,
        };
      };

      res.json({
        members: await Promise.all(
          [...userIds].map((userId) => serializeMember(userId)),
        ),
      });
    } catch (error) {
      next(error);
    }
  }

  static async kickMember(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);
      const targetUserId = String(req.params.userId);

      const removed = await removeMember(bridge.id, targetUserId);
      if (!removed) {
        throw new HttpException(HttpStatusCode.NotFound, "Member not found");
      }

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async sendChat(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge } = await MeBridgesController.requireAccessibleBridge(req);
      const content = String(req.body?.content ?? "").trim();
      if (!content) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "content is required",
        );
      }
      if (content.length > 500) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "content must be 500 characters or less",
        );
      }

      const connected = connectedServerIds(bridge.id.toString());
      const servers = await db.query.bridgeMinecraftServersTable.findMany({
        where: eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
      });
      const serverId = sanitizeServerId(
        String(
          req.body?.serverId ?? connected[0] ?? servers[0]?.serverId ?? "",
        ),
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

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await MeBridgesController.requireBridgeFromParams(req);
      await SpaceBridgeController.requireBridgeAdmin(req, bridge);

      await db.delete(bridgesTable).where(eq(bridgesTable.id, bridge.id));

      void DiscordBridgePeer.reloadBindings();
      void AppBridgePeer.reloadBridges();

      res.status(HttpStatusCode.NoContent).send();
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

  static async requireBridgeFromParams(req: Request) {
    const bridgeId = BigInt(String(req.params.bridgeId));
    const bridge = await db.query.bridgesTable.findFirst({
      where: eq(bridgesTable.id, bridgeId),
    });
    if (!bridge) {
      throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
    }
    return bridge;
  }

  static async requireAccessibleBridge(req: Request) {
    const { user } = req;
    const bridge = await MeBridgesController.requireBridgeFromParams(req);
    const role = await roleForBridge(bridge, user.id);
    if (!role) {
      throw new HttpException(HttpStatusCode.Forbidden, "No bridge access");
    }
    return { bridge, role };
  }

  static async listAccessibleBridges(userId: bigint) {
    const [memberships, spaceMemberships] = await Promise.all([
      db.query.bridgeMembersTable.findMany({
        where: eq(bridgeMembersTable.userId, userId),
      }),
      db.query.spaceMembersTable.findMany({
        where: eq(spaceMembersTable.userId, userId),
      }),
    ]);

    const accessWhere = or(
      memberships.length > 0
        ? inArray(
            bridgesTable.id,
            memberships.map((m) => m.bridgeId),
          )
        : undefined,
      spaceMemberships.length > 0
        ? inArray(
            bridgesTable.spaceId,
            spaceMemberships.map((m) => m.spaceId),
          )
        : undefined,
    );

    if (!accessWhere) return [];

    return db.query.bridgesTable.findMany({
      where: and(accessWhere, eq(bridgesTable.status, 0)),
    });
  }
}

class BridgesDetailHandler {
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

const sanitizeServerId = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, "");

export { MeBridgesController as default };
