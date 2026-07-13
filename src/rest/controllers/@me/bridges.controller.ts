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
  isBridgeOnline,
  linkedUsersByMinecraftUuids,
  listBridgeMessages,
  playersForBridge,
  publishBridgeEvent,
  removeAllMembershipsForUser,
  removeMember,
  type BridgeChatPayload,
  type BridgeRole,
} from "@mutualzz/minecraft";
import { DiscordBridgePeer } from "@mutualzz/bot/bridge/DiscordBridgePeer";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import { and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const MAX_BRIDGES_PER_USER = 5;

const roleForBridge = (
  bridge: { ownerId: bigint },
  userId: string | bigint,
): BridgeRole =>
  bridge.ownerId ===
  (typeof userId === "bigint" ? userId : BigInt(userId))
    ? "owner"
    : "member";

const serializeBridge = (
  bridge: typeof bridgesTable.$inferSelect,
  extras?: Record<string, unknown>,
) => ({
  id: bridge.id.toString(),
  ownerId: bridge.ownerId.toString(),
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

export default class BridgesController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const uid = BigInt(user.id);
      const includeArchived =
        req.query.archived === "1" || req.query.archived === "true";

      const memberships = await db.query.bridgeMembersTable.findMany({
        where: eq(bridgeMembersTable.userId, uid),
      });
      const memberBridgeIds = memberships.map((m) => m.bridgeId);

      // Owners may include archived; members only ever see active bridges.
      const listWhere = includeArchived
        ? memberBridgeIds.length > 0
          ? or(
              eq(bridgesTable.ownerId, uid),
              and(
                inArray(bridgesTable.id, memberBridgeIds),
                eq(bridgesTable.status, 0),
              ),
            )
          : eq(bridgesTable.ownerId, uid)
        : memberBridgeIds.length > 0
          ? and(
              or(
                eq(bridgesTable.ownerId, uid),
                inArray(bridgesTable.id, memberBridgeIds),
              ),
              eq(bridgesTable.status, 0),
            )
          : and(eq(bridgesTable.ownerId, uid), eq(bridgesTable.status, 0));

      const bridges = await db.query.bridgesTable.findMany({
        where: listWhere,
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
        bridges.map((bridge) => {
          const lastAckedId = lastAckedByBridge.get(bridge.id.toString()) ?? "";
          return serializeBridge(bridge, {
            role: roleForBridge(bridge, uid),
            hubConnected: isBridgeOnline(bridge.id.toString()),
            onlineCount: playersForBridge(bridge.id.toString()).length,
            lastAckedId: lastAckedId.length > 0 ? lastAckedId : null,
            unread: isUnread(bridge.lastMessageId, lastAckedId),
          });
        }),
      );
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const name = String(req.body?.name ?? "My Minecraft Bridge").trim();
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

      const { value: bridgeCount } = await db
        .select({ value: count() })
        .from(bridgesTable)
        .where(
          and(
            eq(bridgesTable.ownerId, BigInt(user.id)),
            eq(bridgesTable.status, 0),
          ),
        )
        .then((r) => r[0]);

      if (bridgeCount >= MAX_BRIDGES_PER_USER) {
        throw new HttpException(
          HttpStatusCode.Conflict,
          `You can create at most ${MAX_BRIDGES_PER_USER} bridges`,
        );
      }

      const bridgeId = BigInt(Snowflake.generate());
      const [bridge] = await db
        .insert(bridgesTable)
        .values({
          id: bridgeId,
          ownerId: BigInt(user.id),
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
        ...serializeBridge(bridge, { role: "owner" as const }),
        token: token.plaintext,
        pluginConfig: buildPluginConfig(token.plaintext, serverId || undefined),
      });

      void AppBridgePeer.reloadBridges();
    } catch (error) {
      next(error);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge, role } =
        await BridgesController.requireAccessibleBridge(req);
      const servers = await db.query.bridgeMinecraftServersTable.findMany({
        where: eq(bridgeMinecraftServersTable.bridgeId, bridge.id),
      });
      const bindings =
        role === "owner"
          ? await db.query.bridgeDiscordBindingsTable.findMany({
              where: eq(bridgeDiscordBindingsTable.bridgeId, bridge.id),
            })
          : [];
      const voiceBindings =
        role === "owner"
          ? await db.query.bridgeVoiceBindingsTable.findMany({
              where: eq(bridgeVoiceBindingsTable.bridgeId, bridge.id),
            })
          : [];
      const tokens =
        role === "owner"
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

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await BridgesController.requireOwnedBridge(req);
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
      const bridge = await BridgesController.requireOwnedBridge(req);
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
      const { bridge } = await BridgesController.requireAccessibleBridge(req);
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
      const { bridge } = await BridgesController.requireAccessibleBridge(req);
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
      const bridge = await BridgesController.requireOwnedBridge(req);

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
      const bridge = await BridgesController.requireOwnedBridge(req);
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

  static async bindVoice(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const bridge = await BridgesController.requireOwnedBridge(req);
      const serverId = String(req.body?.serverId ?? "").trim();
      const spaceId = String(req.body?.spaceId ?? "").trim();
      const channelId = String(req.body?.channelId ?? "").trim();
      const nameRaw = String(req.body?.name ?? "default").trim().toLowerCase();
      const name = nameRaw.replace(/[^a-z0-9_-]/g, "") || "default";

      if (!serverId || !spaceId || !channelId) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "serverId, spaceId, and channelId are required",
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
          "channelId must be a Mutualzz voice channel in the given space",
        );
      }

      const member = await db.query.spaceMembersTable.findFirst({
        where: and(
          eq(spaceMembersTable.spaceId, BigInt(spaceId)),
          eq(spaceMembersTable.userId, BigInt(user.id)),
        ),
      });
      if (!member) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You must be a member of that space to bind its voice channel",
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
          spaceId: updated.spaceId.toString(),
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
        spaceId: created.spaceId.toString(),
        channelId: created.channelId.toString(),
      });
    } catch (error) {
      next(error);
    }
  }

  static async unbindDiscord(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await BridgesController.requireOwnedBridge(req);
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
      const bridge = await BridgesController.requireOwnedBridge(req);
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

  /** Create a link code for the current Mutualzz user (redeem with /mzlink in MC).
   * Linking is account-wide. Any online owned or member bridge can mint a code. */
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

      const accessible = await BridgesController.listAccessibleBridges(uid);
      if (accessible.length === 0) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Join a Mutualzz Minecraft server or create a bridge before linking",
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

  /** Complete a code that was started from Minecraft (pending uuid on the code). */
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

      const linked = {
        minecraftUuid: row.minecraftUuid,
        minecraftName: row.minecraftName,
        discordId: row.discordId,
        createdAt: new Date(),
      };

      emitMinecraftLinkUpdate(user.id, linked);

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
      if (bridge.ownerId === BigInt(user.id)) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Owners cannot leave their own bridge",
        );
      }

      const removed = await removeMember(bridgeId, user.id);
      if (!removed) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Not a member of this bridge",
        );
      }

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async listMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await BridgesController.requireOwnedBridge(req);
      const memberRows = await db.query.bridgeMembersTable.findMany({
        where: eq(bridgeMembersTable.bridgeId, bridge.id),
      });

      const userIds = [
        bridge.ownerId,
        ...memberRows.map((m) => m.userId),
      ];
      const uniqueIds = [...new Set(userIds.map((id) => id.toString()))].map(
        (id) => BigInt(id),
      );

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
        memberRows.map((m) => [m.userId.toString(), m.joinedAt]),
      );

      const serializeMember = (
        userId: bigint,
        role: "owner" | "member",
        joinedAt: Date,
      ) => {
        const u = usersById.get(userId.toString());
        const link = linksByUser.get(userId.toString());
        return {
          userId: userId.toString(),
          role,
          username: u?.username ?? "Unknown",
          globalName: u?.globalName ?? null,
          avatar: u?.avatar ?? null,
          joinedAt,
          online: isOnline(link?.minecraftUuid),
          minecraftUuid: link?.minecraftUuid ?? null,
          minecraftName: link?.minecraftName ?? null,
        };
      };

      res.json({
        members: [
          serializeMember(bridge.ownerId, "owner", bridge.createdAt),
          ...memberRows
            .filter((m) => m.userId !== bridge.ownerId)
            .map((m) =>
              serializeMember(
                m.userId,
                "member",
                joinedAtByUser.get(m.userId.toString()) ?? m.joinedAt,
              ),
            ),
        ],
      });
    } catch (error) {
      next(error);
    }
  }

  static async kickMember(req: Request, res: Response, next: NextFunction) {
    try {
      const bridge = await BridgesController.requireOwnedBridge(req);
      const targetUserId = String(req.params.userId);
      if (targetUserId === bridge.ownerId.toString()) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot remove the bridge owner",
        );
      }

      const removed = await removeMember(bridge.id, targetUserId);
      if (!removed) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Member not found",
        );
      }

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }

  static async sendChat(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { bridge } = await BridgesController.requireAccessibleBridge(req);
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
      const bridge = await BridgesController.requireOwnedBridge(req);

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

  private static async requireOwnedBridge(req: Request) {
    const { user } = req;
    const bridgeId = BigInt(String(req.params.bridgeId));
    const bridge = await db.query.bridgesTable.findFirst({
      where: eq(bridgesTable.id, bridgeId),
    });
    if (!bridge) {
      throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
    }
    if (bridge.ownerId !== BigInt(user.id)) {
      throw new HttpException(HttpStatusCode.Forbidden, "Not your bridge");
    }
    return bridge;
  }

  private static async requireAccessibleBridge(req: Request) {
    const { user } = req;
    const uid = BigInt(user.id);
    const bridgeId = BigInt(String(req.params.bridgeId));
    const bridge = await db.query.bridgesTable.findFirst({
      where: eq(bridgesTable.id, bridgeId),
    });
    if (!bridge) {
      throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
    }
    if (bridge.ownerId === uid) {
      return { bridge, role: "owner" as const };
    }

    const membership = await db.query.bridgeMembersTable.findFirst({
      where: and(
        eq(bridgeMembersTable.bridgeId, bridgeId),
        eq(bridgeMembersTable.userId, uid),
      ),
    });
    if (!membership) {
      throw new HttpException(HttpStatusCode.Forbidden, "Not a bridge member");
    }
    return { bridge, role: "member" as const };
  }

  private static async listAccessibleBridges(userId: bigint) {
    const memberships = await db.query.bridgeMembersTable.findMany({
      where: eq(bridgeMembersTable.userId, userId),
    });
    const memberBridgeIds = memberships.map((m) => m.bridgeId);
    const ownedOrMember =
      memberBridgeIds.length > 0
        ? or(
            eq(bridgesTable.ownerId, userId),
            inArray(bridgesTable.id, memberBridgeIds),
          )
        : eq(bridgesTable.ownerId, userId);

    return db.query.bridgesTable.findMany({
      where: and(ownedOrMember, eq(bridgesTable.status, 0)),
    });
  }
}

const sanitizeServerId = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
