import { memberFlags, permissionFlags, roleFlags } from "@mutualzz/bitfield";
import {
  channelsTable,
  db,
  expressionsTable,
  invitesTable,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  spacesTable,
} from "@mutualzz/database";
import type { APIChannel, APIRole, APISpace } from "@mutualzz/types";
import {
  ChannelType,
  ExpressionType,
  HttpException,
  HttpStatusCode,
  InviteType,
} from "@mutualzz/types";
import {
  emitEvent,
  execNormalized,
  fireAndForgetAll,
  generateHash,
  Snowflake,
} from "@mutualzz/util";
import {
  validateDiscordImportExecute,
  validateDiscordImportPreview,
} from "@mutualzz/validators";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  discordBotInviteUrl,
  discordEmojiUrl,
  fetchDiscordGuildChannels,
  fetchDiscordGuildEmojis,
  fetchDiscordGuildRoles,
  mapDiscordChannelType,
  mapDiscordPermissions,
} from "../../util/discordApi.ts";
import { bucketName, s3Client } from "@mutualzz/util";

export default class DiscordImportController {
  static async botInvite(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ url: discordBotInviteUrl() });
    } catch (error) {
      next(error);
    }
  }

  static async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const { guildId } = validateDiscordImportPreview.parse(req.body);

      const [channels, roles, emojis] = await Promise.all([
        fetchDiscordGuildChannels(guildId),
        fetchDiscordGuildRoles(guildId),
        fetchDiscordGuildEmojis(guildId),
      ]);

      const mappedChannels = channels
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: mapDiscordChannelType(channel.type),
          position: channel.position,
          parentId: channel.parent_id ?? null,
        }))
        .filter((channel) => channel.type !== null);

      res.json({
        guildId,
        channels: mappedChannels,
        roles: roles
          .filter((role) => role.name !== "@everyone")
          .map((role) => ({
            id: role.id,
            name: role.name,
            color: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : null,
            hoist: role.hoist,
            position: role.position,
          })),
        emojis: emojis.map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
        })),
        skippedChannelCount: channels.length - mappedChannels.length,
      });
    } catch (error) {
      next(error);
    }
  }

  static async execute(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { guildId, spaceName } = validateDiscordImportExecute.parse(req.body);

      const [channels, roles, emojis] = await Promise.all([
        fetchDiscordGuildChannels(guildId),
        fetchDiscordGuildRoles(guildId),
        fetchDiscordGuildEmojis(guildId),
      ]);

      const spaceId = BigInt(Snowflake.generate());

      const result = await db.transaction(async (tx) => {
        const space = await execNormalized<APISpace | null>(
          tx
            .insert(spacesTable)
            .values({
              id: spaceId,
              name: spaceName,
              ownerId: BigInt(user.id),
            })
            .returning()
            .then((rows) => (rows.length ? rows[0] : null)),
        );

        if (!space) {
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create space",
          );
        }

        await tx.insert(spaceMembersTable).values({
          spaceId,
          userId: BigInt(user.id),
          flags: memberFlags.Owner,
        });

        const everyoneRole = await execNormalized<APIRole | null>(
          tx
            .insert(rolesTable)
            .values({
              id: BigInt(space.id),
              name: "@everyone",
              spaceId,
              flags: roleFlags.Everyone,
              allow:
                permissionFlags.ViewChannel |
                permissionFlags.SendMessages |
                permissionFlags.CreateInvites |
                permissionFlags.Connect |
                permissionFlags.Speak |
                permissionFlags.ReadMessageHistory |
                permissionFlags.AddReactions |
                permissionFlags.AttachFiles |
                permissionFlags.EmbedLinks,
            })
            .returning()
            .then((rows) => (rows.length ? rows[0] : null)),
        );

        if (!everyoneRole) {
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create default role",
          );
        }

        await tx.insert(spaceMemberRolesTable).values({
          spaceId,
          userId: BigInt(user.id),
          roleId: BigInt(everyoneRole.id),
        });

        const categoryIdMap = new Map<string, bigint>();
        const sortedChannels = [...channels].sort(
          (a, b) => a.position - b.position,
        );

        for (const channel of sortedChannels) {
          const mappedType = mapDiscordChannelType(channel.type);
          if (mappedType === null) continue;

          const created = await execNormalized<APIChannel | null>(
            tx
              .insert(channelsTable)
              .values({
                id: BigInt(Snowflake.generate()),
                type: mappedType,
                spaceId,
                name: channel.name.slice(0, 100),
                position: channel.position,
                parentId:
                  channel.parent_id && categoryIdMap.has(channel.parent_id)
                    ? categoryIdMap.get(channel.parent_id)
                    : null,
              })
              .returning()
              .then((rows) => (rows.length ? rows[0] : null)),
          );

          if (created && mappedType === ChannelType.Category) {
            categoryIdMap.set(channel.id, BigInt(created.id));
          }
        }

        const sortedRoles = [...roles]
          .filter((role) => role.name !== "@everyone")
          .sort((a, b) => b.position - a.position);

        for (const role of sortedRoles) {
          const createdRole = await execNormalized<APIRole | null>(
            tx
              .insert(rolesTable)
              .values({
                id: BigInt(Snowflake.generate()),
                spaceId,
                name: role.name.slice(0, 100),
                color: role.color
                  ? `#${role.color.toString(16).padStart(6, "0")}`
                  : "#99aab5",
                hoist: role.hoist,
                allow: mapDiscordPermissions(role.permissions),
              })
              .returning()
              .then((rows) => (rows.length ? rows[0] : null)),
          );

          if (createdRole) {
            await tx.insert(spaceMemberRolesTable).values({
              spaceId,
              userId: BigInt(user.id),
              roleId: BigInt(createdRole.id),
            });
          }
        }

        for (const emoji of emojis.slice(0, 50)) {
          try {
            const url = discordEmojiUrl(emoji);
            const res = await fetch(url);
            if (!res.ok) continue;
            const buffer = Buffer.from(await res.arrayBuffer());
            const isGif = !!emoji.animated;
            const hash = generateHash(buffer, isGif);
            const ext = isGif ? "gif" : "png";

            await s3Client.send(
              new PutObjectCommand({
                Bucket: bucketName,
                Body: buffer,
                Key: `expressions/spaces/${spaceId}/${hash}.${ext}`,
                ContentType: isGif ? "image/gif" : "image/png",
              }),
            );

            await tx.insert(expressionsTable).values({
              id: BigInt(Snowflake.generate()),
              spaceId,
              authorId: BigInt(user.id),
              name: emoji.name.slice(0, 32),
              type: ExpressionType.Emoji,
              assetHash: isGif ? `a_${hash}` : hash,
            });
          } catch {
            continue;
          }
        }

        const inviteCode = Snowflake.generate().slice(-8);
        await tx.insert(invitesTable).values({
          code: inviteCode,
          type: InviteType.Space,
          spaceId,
          inviterId: BigInt(user.id),
        });

        return { space, inviteCode };
      });

      fireAndForgetAll([
        {
          label: "event:SpaceCreate",
          run: () =>
            emitEvent({
              event: "SpaceCreate",
              user_id: user.id,
              data: { space: result.space },
            }),
        },
      ]);

      res.status(HttpStatusCode.Created).json({
        space: result.space,
        inviteCode: result.inviteCode,
      });
    } catch (error) {
      next(error);
    }
  }
}
