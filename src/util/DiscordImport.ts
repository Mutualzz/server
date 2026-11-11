import { memberFlags, permissionFlags, roleFlags } from "@mutualzz/bitfield";
import { setCache } from "@mutualzz/cache";
import { Logger } from "@mutualzz/logger";
import {
  channelRoleOverwritesTable,
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
  APIChannelPermissionOverwrite,
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
import { CHANNEL_TOPIC_MAX_LENGTH } from "@mutualzz/validators";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import {
  bucketName,
  emitEvent,
  execNormalized,
  fireAndForgetAll,
  generateHash,
  redis,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  type DiscordGuild,
  type DiscordGuildChannel,
  discordEmojiUrl,
  discordGuildIconUrl,
  DiscordStickerFormat,
  discordStickerUrl,
  fetchDiscordGuild,
  fetchDiscordGuildChannels,
  fetchDiscordGuildEmojis,
  fetchDiscordGuildRoles,
  fetchDiscordGuildStickers,
  isImportableDiscordSticker,
  leaveDiscordGuild,
  mapDiscordChannelType,
  mapDiscordPermissions,
  sortDiscordChannelsForDisplay,
} from "./discordApi.ts";

const logger = new Logger({ tag: "DiscordImport" });

export const MAX_IMPORTED_EXPRESSIONS = 100;
const DISCORD_CATEGORY_TYPE = 4;
const IMPORTED_ICON_SIZE = 512;
const MAX_DESCRIPTION_LENGTH = 1000;
const IMPORT_GRANT_TTL_SECONDS = 30 * 60;

export type DiscordImportProgressCallback = (
  stage: DiscordImportStage,
  completed: number,
  total: number,
) => void;

export interface DiscordImportSelection {
  channelIds?: string[];
  roleIds?: string[];
  emojiIds?: string[];
  stickerIds?: string[];
}

interface RunDiscordImportOptions {
  userId: string;
  guildId: string;
  spaceName: string;
  selection?: DiscordImportSelection;
  onProgress?: DiscordImportProgressCallback;
}

interface ExpressionDownload {
  url: string;
  name: string;
  type: ExpressionType;
  isAnimated: boolean;
}

export interface DiscordImportGrant {
  leaveAfterImport: boolean;
}

const firstRow = <Row>(rows: Row[]) => (rows.length ? rows[0] : null);

const isSelected = (selectedIds: string[] | undefined, id: string) =>
  !selectedIds || selectedIds.includes(id);

const ACTIVE_GRANTS_KEY = "discord:import-active-grants";
const GUILDS_TO_LEAVE_KEY = "discord:import-guilds-to-leave";

const importGrantKey = (userId: string, guildId: string) =>
  `discord:import-grant:${userId}:${guildId}`;

const BOT_JOIN_GRACE_SECONDS = 15 * 60;

const activeGrantMember = (userId: string, guildId: string) =>
  `${userId}:${guildId}`;

const botJoinMember = (guildId: string) => `bot-join:${guildId}`;

export async function createDiscordImportGrant(
  userId: string,
  guildId: string,
  grant: DiscordImportGrant,
) {
  await redis.set(
    importGrantKey(userId, guildId),
    JSON.stringify(grant),
    "EX",
    IMPORT_GRANT_TTL_SECONDS,
  );
  await redis.zadd(
    ACTIVE_GRANTS_KEY,
    Date.now() + IMPORT_GRANT_TTL_SECONDS * 1000,
    activeGrantMember(userId, guildId),
  );
  await redis.zrem(ACTIVE_GRANTS_KEY, botJoinMember(guildId));
  if (grant.leaveAfterImport) await redis.sadd(GUILDS_TO_LEAVE_KEY, guildId);
}

export async function markDiscordImportBotJoin(guildId: string) {
  if (!(await hasActiveGrantForGuild(guildId)))
    await redis.zadd(
      ACTIVE_GRANTS_KEY,
      Date.now() + BOT_JOIN_GRACE_SECONDS * 1000,
      botJoinMember(guildId),
    );
  await redis.sadd(GUILDS_TO_LEAVE_KEY, guildId);
}

async function hasActiveGrantForGuild(guildId: string) {
  const activeMembers = await redis.zrangebyscore(
    ACTIVE_GRANTS_KEY,
    Date.now(),
    "+inf",
  );
  return activeMembers.some((member) => member.endsWith(`:${guildId}`));
}

async function leaveGuildIfUnused(guildId: string) {
  if (!(await redis.sismember(GUILDS_TO_LEAVE_KEY, guildId))) return false;
  if (await hasActiveGrantForGuild(guildId)) return false;
  await leaveDiscordGuild(guildId);
  await redis.srem(GUILDS_TO_LEAVE_KEY, guildId);
  return true;
}

export async function leaveAbandonedDiscordImportGuilds() {
  await redis.zremrangebyscore(ACTIVE_GRANTS_KEY, 0, Date.now());

  const guildIds = await redis.smembers(GUILDS_TO_LEAVE_KEY);
  let leftGuildCount = 0;

  for (const guildId of guildIds) {
    try {
      if (await leaveGuildIfUnused(guildId)) leftGuildCount++;
    } catch (error) {
      logger.warn(`Failed to leave imported Discord server ${guildId}`, error);
    }
  }

  return leftGuildCount;
}

export async function hasDiscordImportGrant(userId: string, guildId: string) {
  return (await redis.exists(importGrantKey(userId, guildId))) === 1;
}

export async function consumeDiscordImportGrant(
  userId: string,
  guildId: string,
) {
  const rawGrant = await redis.getdel(importGrantKey(userId, guildId));
  return rawGrant ? (JSON.parse(rawGrant) as DiscordImportGrant) : null;
}

async function uploadImage(buffer: Buffer, key: string, isAnimated: boolean) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Body: buffer,
      Key: key,
      ContentType: isAnimated ? "image/gif" : "image/png",
    }),
  );
}

async function uploadGuildIcon(guild: DiscordGuild, spaceId: bigint) {
  const iconUrl = discordGuildIconUrl(guild, IMPORTED_ICON_SIZE);
  if (!iconUrl) return null;

  try {
    const response = await fetch(iconUrl);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const isAnimated = guild.icon?.startsWith("a_") ?? false;
    const iconHash = generateHash(buffer, isAnimated);
    await uploadImage(
      buffer,
      `icons/spaces/${spaceId}/${iconHash}.${isAnimated ? "gif" : "png"}`,
      isAnimated,
    );
    return iconHash;
  } catch {
    return null;
  }
}

async function uploadExpression(download: ExpressionDownload) {
  try {
    const response = await fetch(download.url);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const expressionId = BigInt(Snowflake.generate());
    const assetHash = generateHash(buffer, download.isAnimated);
    await uploadImage(
      buffer,
      `expressions/${expressionId}/${assetHash}.${download.isAnimated ? "gif" : "png"}`,
      download.isAnimated,
    );

    return {
      expressionId,
      assetHash,
      name: download.name,
      type: download.type,
    };
  } catch {
    return null;
  }
}

export async function runDiscordImport(options: RunDiscordImportOptions) {
  const { userId, guildId } = options;

  const grant = await consumeDiscordImportGrant(userId, guildId);
  if (!grant) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "Authorize the Mutualzz bot for this server before importing it",
    );
  }

  let result: Awaited<ReturnType<typeof performDiscordImport>>;
  try {
    result = await performDiscordImport(options);
  } catch (error) {
    await createDiscordImportGrant(userId, guildId, grant);
    throw error;
  }

  await redis.zrem(ACTIVE_GRANTS_KEY, activeGrantMember(userId, guildId));
  fireAndForgetAll([
    {
      label: "discord:import:leave-guild",
      run: () => leaveGuildIfUnused(guildId),
      meta: { guildId, userId },
    },
  ]);

  return result;
}

async function performDiscordImport({
  userId,
  guildId,
  spaceName,
  selection = {},
  onProgress = () => undefined,
}: RunDiscordImportOptions) {
  onProgress("fetching", 0, 1);

  const [guild, channels, roles, emojis, stickers] = await Promise.all([
    fetchDiscordGuild(guildId),
    fetchDiscordGuildChannels(guildId),
    fetchDiscordGuildRoles(guildId),
    fetchDiscordGuildEmojis(guildId),
    fetchDiscordGuildStickers(guildId),
  ]);

  onProgress("fetching", 1, 1);

  const spaceId = BigInt(Snowflake.generate());

  const selectedEmojis = emojis.filter((emoji) =>
    isSelected(selection.emojiIds, emoji.id),
  );
  const selectedStickers = stickers.filter(
    (sticker) =>
      isImportableDiscordSticker(sticker) &&
      isSelected(selection.stickerIds, sticker.id),
  );
  const expressionDownloads: ExpressionDownload[] = [
    ...selectedEmojis.map((emoji) => ({
      url: discordEmojiUrl(emoji),
      name: emoji.name.slice(0, 32),
      type: ExpressionType.Emoji,
      isAnimated: !!emoji.animated,
    })),
    ...selectedStickers.map((sticker) => ({
      url: discordStickerUrl(sticker),
      name: sticker.name.slice(0, 32),
      type: ExpressionType.Sticker,
      isAnimated: sticker.format_type === DiscordStickerFormat.Gif,
    })),
  ].slice(0, MAX_IMPORTED_EXPRESSIONS);

  let processedExpressionCount = 0;
  onProgress("emojis", 0, expressionDownloads.length);

  const [iconHash, uploadedExpressions] = await Promise.all([
    uploadGuildIcon(guild, spaceId),
    Promise.all(
      expressionDownloads.map(async (download) => {
        const uploaded = await uploadExpression(download);
        processedExpressionCount++;
        onProgress(
          "emojis",
          processedExpressionCount,
          expressionDownloads.length,
        );
        return uploaded;
      }),
    ).then((results) => results.filter((uploaded) => uploaded !== null)),
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
          description:
            guild.description?.trim().slice(0, MAX_DESCRIPTION_LENGTH) || null,
        })
        .returning()
        .then(firstRow),
    );

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

    if (!space || !ownerMember || !everyoneRole) {
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

    const sortedRoles = roles
      .filter(
        (role) =>
          role.id !== guildId &&
          !role.managed &&
          isSelected(selection.roleIds, role.id),
      )
      .sort(
        (first, second) =>
          first.position - second.position ||
          Number(BigInt(second.id) - BigInt(first.id)),
      );

    const roleIdMap = new Map<string, bigint>([[guildId, spaceId]]);
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
            mentionable: role.mentionable,
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
      roleIdMap.set(role.id, BigInt(createdRole.id));
      await assignRoleToOwner(BigInt(createdRole.id));
      onProgress("roles", index + 1, sortedRoles.length);
    }

    const importableChannels = channels.filter(
      (channel) =>
        mapDiscordChannelType(channel.type) !== null &&
        isSelected(selection.channelIds, channel.id),
    );
    const discordCategoryIds = new Set(
      importableChannels
        .filter((channel) => channel.type === DISCORD_CATEGORY_TYPE)
        .map((channel) => channel.id),
    );
    const categoryIdMap = new Map<string, bigint>();
    const createdChannels: APIChannel[] = [];
    onProgress("channels", 0, importableChannels.length);

    const insertChannelOverwrites = async (
      channel: DiscordGuildChannel,
      createdChannelId: bigint,
    ) => {
      const overwriteRows = (channel.permission_overwrites ?? [])
        .filter((overwrite) => overwrite.type === 0)
        .map((overwrite) => ({
          roleId: roleIdMap.get(overwrite.id),
          allow: mapDiscordPermissions(overwrite.allow),
          deny: mapDiscordPermissions(overwrite.deny),
        }))
        .filter(
          (overwrite): overwrite is typeof overwrite & { roleId: bigint } =>
            overwrite.roleId !== undefined &&
            (overwrite.allow !== 0n || overwrite.deny !== 0n),
        )
        .map((overwrite) => ({
          channelId: createdChannelId,
          spaceId,
          ...overwrite,
        }));

      if (!overwriteRows.length) return [];

      const insertedOverwrites = await execNormalized<
        APIChannelPermissionOverwrite[]
      >(
        tx.insert(channelRoleOverwritesTable).values(overwriteRows).returning(),
      );

      return (insertedOverwrites ?? []).map((overwrite) => ({
        ...overwrite,
        userId: null,
      }));
    };

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
            topic:
              channel.topic?.trim().slice(0, CHANNEL_TOPIC_MAX_LENGTH) || null,
            nsfw: channel.nsfw ?? false,
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

      const overwrites = await insertChannelOverwrites(
        channel,
        BigInt(createdChannel.id),
      );
      createdChannels.push({ ...createdChannel, overwrites });
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

    onProgress("finishing", 0, 1);

    const createdExpressions: APIExpression[] = [];
    for (const uploadedExpression of uploadedExpressions) {
      const createdExpression = await execNormalized<APIExpression | null>(
        tx
          .insert(expressionsTable)
          .values({
            id: uploadedExpression.expressionId,
            spaceId,
            authorId: BigInt(userId),
            name: uploadedExpression.name,
            type: uploadedExpression.type,
            assetHash: uploadedExpression.assetHash,
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
    importedExpressionCount: result.expressions.length,
    skippedExpressionCount:
      selectedEmojis.length +
      selectedStickers.length -
      result.expressions.length,
  };
}
