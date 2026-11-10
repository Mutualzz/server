import { memberFlags, permissionFlags, roleFlags } from "@mutualzz/bitfield";
import { setCache } from "@mutualzz/cache";
import {
  channelsTable,
  db,
  expressionsTable,
  invitesTable,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  spacesTable,
  userSettingsTable,
} from "@mutualzz/database";
import type {
  APIChannel,
  APIExpression,
  APIMemberRole,
  APIRole,
  APISpace,
  APISpaceMember,
  APIUserSettings,
  ChannelType,
  DiscordImportStage,
} from "@mutualzz/types";
import {
  ExpressionType,
  HttpException,
  HttpStatusCode,
  InviteType,
} from "@mutualzz/types";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import {
  bucketName,
  emitEvent,
  execNormalized,
  fireAndForgetAll,
  generateHash,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  type DiscordGuild,
  type DiscordGuildChannel,
  discordEmojiUrl,
  discordGuildIconUrl,
  fetchDiscordGuild,
  fetchDiscordGuildChannels,
  fetchDiscordGuildEmojis,
  fetchDiscordGuildRoles,
  mapDiscordChannelType,
  mapDiscordPermissions,
  sortDiscordChannelsForDisplay,
} from "./discordApi.ts";

const MAX_IMPORTED_EMOJIS = 100;
const DISCORD_CATEGORY_TYPE = 4;
const IMPORTED_ICON_SIZE = 512;

export type DiscordImportProgressCallback = (
  stage: DiscordImportStage,
  completed: number,
  total: number,
) => void;

interface RunDiscordImportOptions {
  userId: string;
  guildId: string;
  spaceName: string;
  onProgress?: DiscordImportProgressCallback;
}

const firstRow = <Row>(rows: Row[]) => (rows.length ? rows[0] : null);

async function uploadGuildIcon(guild: DiscordGuild, spaceId: bigint) {
  const iconUrl = discordGuildIconUrl(guild, IMPORTED_ICON_SIZE);
  if (!iconUrl) return null;

  try {
    const response = await fetch(iconUrl);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const isAnimated = guild.icon?.startsWith("a_") ?? false;
    const iconHash = generateHash(buffer, isAnimated);
    const extension = isAnimated ? "gif" : "png";

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Body: buffer,
        Key: `icons/spaces/${spaceId}/${iconHash}.${extension}`,
        ContentType: isAnimated ? "image/gif" : "image/png",
      }),
    );

    return iconHash;
  } catch {
    return null;
  }
}

export async function runDiscordImport({
  userId,
  guildId,
  spaceName,
  onProgress = () => undefined,
}: RunDiscordImportOptions) {
  onProgress("fetching", 0, 1);

  const [guild, channels, roles, emojis] = await Promise.all([
    fetchDiscordGuild(guildId),
    fetchDiscordGuildChannels(guildId),
    fetchDiscordGuildRoles(guildId),
    fetchDiscordGuildEmojis(guildId),
  ]);

  onProgress("fetching", 1, 1);

  const spaceId = BigInt(Snowflake.generate());
  const emojisToImport = emojis.slice(0, MAX_IMPORTED_EMOJIS);
  let processedEmojiCount = 0;
  onProgress("emojis", 0, emojisToImport.length);

  const [iconHash, uploadedEmojis] = await Promise.all([
    uploadGuildIcon(guild, spaceId),
    Promise.all(
      emojisToImport.map(async (emoji) => {
        try {
          const response = await fetch(discordEmojiUrl(emoji));
          if (!response.ok) return null;

          const buffer = Buffer.from(await response.arrayBuffer());
          const expressionId = BigInt(Snowflake.generate());
          const isAnimated = !!emoji.animated;
          const assetHash = generateHash(buffer, isAnimated);
          const extension = isAnimated ? "gif" : "png";

          await s3Client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Body: buffer,
              Key: `expressions/${expressionId}/${assetHash}.${extension}`,
              ContentType: isAnimated ? "image/gif" : "image/png",
            }),
          );

          return { expressionId, assetHash, name: emoji.name.slice(0, 32) };
        } catch {
          return null;
        } finally {
          processedEmojiCount++;
          onProgress("emojis", processedEmojiCount, emojisToImport.length);
        }
      }),
    ).then((results) =>
      results.filter((uploadedEmoji) => uploadedEmoji !== null),
    ),
  ]);

  const result = await db.transaction(async (tx) => {
    onProgress("space", 0, 1);

    const space = await execNormalized<APISpace | null>(
      tx
        .insert(spacesTable)
        .values({
          id: spaceId,
          name: spaceName,
          ownerId: BigInt(userId),
          icon: iconHash,
        })
        .returning()
        .then(firstRow),
    );

    if (!space) {
      throw new HttpException(
        HttpStatusCode.InternalServerError,
        "Failed to create space",
      );
    }

    const ownerMember = await execNormalized<APISpaceMember | null>(
      tx
        .insert(spaceMembersTable)
        .values({
          spaceId,
          userId: BigInt(userId),
          flags: memberFlags.Owner,
        })
        .returning()
        .then(firstRow),
    );

    const everyoneRole = await execNormalized<APIRole | null>(
      tx
        .insert(rolesTable)
        .values({
          id: spaceId,
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
        .then(firstRow),
    );

    if (!ownerMember || !everyoneRole) {
      throw new HttpException(
        HttpStatusCode.InternalServerError,
        "Failed to create space",
      );
    }

    const ownerMemberRoles: APIMemberRole[] = [];
    const assignRoleToOwner = async (roleId: bigint) => {
      await tx.insert(spaceMemberRolesTable).values({
        spaceId,
        userId: BigInt(userId),
        roleId,
      });
      ownerMemberRoles.push({
        spaceId: spaceId.toString(),
        userId,
        roleId: roleId.toString(),
      });
    };

    await assignRoleToOwner(spaceId);

    onProgress("space", 1, 1);

    const importableChannels = channels.filter(
      (channel) => mapDiscordChannelType(channel.type) !== null,
    );
    const discordCategoryIds = new Set(
      importableChannels
        .filter((channel) => channel.type === DISCORD_CATEGORY_TYPE)
        .map((channel) => channel.id),
    );
    const categoryIdMap = new Map<string, bigint>();
    const createdChannels: APIChannel[] = [];
    onProgress("channels", 0, importableChannels.length);

    const insertImportedChannel = async (
      channel: DiscordGuildChannel,
      position: number,
      parentId: bigint | null,
    ) => {
      const createdChannel = await execNormalized<APIChannel | null>(
        tx
          .insert(channelsTable)
          .values({
            id: BigInt(Snowflake.generate()),
            type: mapDiscordChannelType(channel.type) as ChannelType,
            spaceId,
            name: channel.name.slice(0, 100),
            position,
            parentId,
          })
          .returning()
          .then(firstRow),
      );

      if (!createdChannel) {
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create channel",
        );
      }

      createdChannels.push(createdChannel);
      onProgress("channels", createdChannels.length, importableChannels.length);
      return BigInt(createdChannel.id);
    };

    const rootChannels = sortDiscordChannelsForDisplay(
      importableChannels.filter(
        (channel) =>
          !channel.parent_id || !discordCategoryIds.has(channel.parent_id),
      ),
    );

    for (const [index, channel] of rootChannels.entries()) {
      const createdChannelId = await insertImportedChannel(
        channel,
        index,
        null,
      );
      if (channel.type === DISCORD_CATEGORY_TYPE)
        categoryIdMap.set(channel.id, createdChannelId);
    }

    for (const [discordCategoryId, createdCategoryId] of categoryIdMap) {
      const childChannels = sortDiscordChannelsForDisplay(
        importableChannels.filter(
          (channel) => channel.parent_id === discordCategoryId,
        ),
      );

      for (const [index, channel] of childChannels.entries()) {
        await insertImportedChannel(channel, index, createdCategoryId);
      }
    }

    const sortedRoles = [...roles]
      .filter((role) => role.id !== guildId && !role.managed)
      .sort(
        (first, second) =>
          first.position - second.position ||
          Number(BigInt(second.id) - BigInt(first.id)),
      );

    const createdRoles: APIRole[] = [everyoneRole];
    onProgress("roles", 0, sortedRoles.length);

    for (const [index, role] of sortedRoles.entries()) {
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
            position: index + 1,
            allow: mapDiscordPermissions(role.permissions),
          })
          .returning()
          .then(firstRow),
      );

      if (!createdRole) {
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create role",
        );
      }

      createdRoles.push(createdRole);
      await assignRoleToOwner(BigInt(createdRole.id));
      onProgress("roles", index + 1, sortedRoles.length);
    }

    onProgress("finishing", 0, 1);

    const createdExpressions: APIExpression[] = [];
    for (const uploadedEmoji of uploadedEmojis) {
      const createdExpression = await execNormalized<APIExpression | null>(
        tx
          .insert(expressionsTable)
          .values({
            id: uploadedEmoji.expressionId,
            spaceId,
            authorId: BigInt(userId),
            name: uploadedEmoji.name,
            type: ExpressionType.Emoji,
            assetHash: uploadedEmoji.assetHash,
          })
          .returning()
          .then(firstRow),
      );
      if (createdExpression) createdExpressions.push(createdExpression);
    }

    const inviteCode = Snowflake.generate().slice(-8);
    await tx.insert(invitesTable).values({
      code: inviteCode,
      type: InviteType.Space,
      spaceId,
      inviterId: BigInt(userId),
    });

    const settings = await execNormalized<APIUserSettings | null>(
      tx
        .insert(userSettingsTable)
        .values({
          userId: BigInt(userId),
          spacePositions: [spaceId],
        })
        .onConflictDoUpdate({
          target: userSettingsTable.userId,
          set: {
            spacePositions: sql`array_prepend(${spaceId}, COALESCE(${userSettingsTable.spacePositions}, ARRAY[]::bigint[]))`,
          },
        })
        .returning()
        .then(firstRow),
    );

    return {
      space,
      ownerMember: { ...ownerMember, roles: ownerMemberRoles },
      channels: createdChannels,
      roles: createdRoles,
      expressions: createdExpressions,
      settings,
      inviteCode,
    };
  });

  onProgress("finishing", 1, 1);

  const fullSpace: APISpace = {
    ...result.space,
    channels: result.channels.map((channel) => ({
      ...channel,
      space: result.space,
    })),
    roles: result.roles,
    expressions: result.expressions,
    members: [result.ownerMember],
  };

  void setCache("space", result.space.id, result.space);
  void setCache(
    "spaceMember",
    `${result.space.id}:${userId}`,
    result.ownerMember,
  );
  for (const channel of result.channels)
    void setCache("channel", channel.id, channel);
  if (result.settings) void setCache("userSettings", userId, result.settings);

  fireAndForgetAll([
    {
      label: "event:DiscordImport",
      run: async () => {
        await emitEvent({
          event: "SpaceCreate",
          user_id: userId,
          data: fullSpace,
        });

        if (result.settings)
          await emitEvent({
            event: "UserSettingsUpdate",
            user_id: userId,
            data: result.settings,
          });
      },
      meta: { spaceId: result.space.id, userId },
    },
  ]);

  return {
    space: result.space,
    inviteCode: result.inviteCode,
    importedEmojiCount: result.expressions.length,
    skippedEmojiCount: emojis.length - result.expressions.length,
  };
}
