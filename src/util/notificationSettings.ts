import {
  db,
  spaceMembersTable,
} from "@mutualzz/database";
import { readStatesTable } from "@mutualzz/database/schemas/ReadState";
import { spaceMemberNotificationSettingsTable } from "@mutualzz/database/schemas/spaces/SpaceMemberNotificationSettings";
import { BitField, readStateFlags } from "@mutualzz/bitfield";
import {
  type APIReadState,
  type APISpaceNotificationSettings,
  DEFAULT_NOTIFICATION_LEVEL,
  NotificationLevel,
  type NotificationMessageContext,
  type NotificationSuppressOptions,
  computeMutedUntilDuration,
  isNotificationMuteActive,
  resolveEffectiveNotificationLevel,
  shouldDeliverMessageNotification,
  shouldIncrementMentionCount,
  ReadStateType,
} from "@mutualzz/types";
import { and, eq, ne } from "drizzle-orm";

export function serializeReadState(row: {
  channelId: bigint;
  lastMessageId: bigint | null;
  lastAckedId: bigint | null;
  notificationsCursor: bigint | null;
  mentionCount: number;
  badgeCount: number;
  lastPinTimestamp: Date | null;
  flags: bigint;
  type: number;
  notificationLevel: number | null;
  mutedUntil: Date | null;
}): APIReadState {
  return {
    id: row.channelId.toString(),
    lastMessageId: row.lastMessageId?.toString() ?? null,
    lastAckedId: row.lastAckedId?.toString() ?? null,
    notificationsCursor: row.notificationsCursor?.toString() ?? null,
    mentionCount: row.mentionCount,
    badgeCount: row.badgeCount,
    lastPinTimestamp: row.lastPinTimestamp,
    flags: row.flags,
    type: row.type as ReadStateType,
    notificationLevel:
      row.notificationLevel == null
        ? null
        : (row.notificationLevel as NotificationLevel),
    mutedUntil: row.mutedUntil,
  };
}

export function serializeSpaceNotificationSettings(row: {
  spaceId: bigint;
  level: number;
  mutedUntil: Date | null;
  suppressEveryone: boolean;
  suppressRoles: boolean;
}): APISpaceNotificationSettings {
  return {
    spaceId: row.spaceId.toString(),
    level: row.level as NotificationLevel,
    mutedUntil: row.mutedUntil,
    suppressEveryone: row.suppressEveryone,
    suppressRoles: row.suppressRoles,
  };
}

export async function getSpaceNotificationSettings(
  userId: string,
  spaceId: string,
): Promise<APISpaceNotificationSettings> {
  const row = await db.query.spaceMemberNotificationSettingsTable.findFirst({
    where: and(
      eq(spaceMemberNotificationSettingsTable.userId, BigInt(userId)),
      eq(spaceMemberNotificationSettingsTable.spaceId, BigInt(spaceId)),
    ),
  });

  if (!row) {
    return {
      spaceId,
      level: DEFAULT_NOTIFICATION_LEVEL,
      mutedUntil: null,
      suppressEveryone: false,
      suppressRoles: false,
    };
  }

  return serializeSpaceNotificationSettings(row);
}

export async function getSpaceNotificationSettingsForUser(
  userId: string,
): Promise<APISpaceNotificationSettings[]> {
  const rows = await db
    .select()
    .from(spaceMemberNotificationSettingsTable)
    .where(eq(spaceMemberNotificationSettingsTable.userId, BigInt(userId)));

  return rows.map(serializeSpaceNotificationSettings);
}

export async function upsertSpaceNotificationSettings(
  userId: string,
  spaceId: string,
  patch: Partial<{
    level: NotificationLevel;
    mutedUntil: Date | null;
    suppressEveryone: boolean;
    suppressRoles: boolean;
  }>,
): Promise<APISpaceNotificationSettings> {
  const existing = await db.query.spaceMemberNotificationSettingsTable.findFirst(
    {
      where: and(
        eq(spaceMemberNotificationSettingsTable.userId, BigInt(userId)),
        eq(spaceMemberNotificationSettingsTable.spaceId, BigInt(spaceId)),
      ),
    },
  );

  const [row] = await db
    .insert(spaceMemberNotificationSettingsTable)
    .values({
      userId: BigInt(userId),
      spaceId: BigInt(spaceId),
      level: patch.level ?? existing?.level ?? DEFAULT_NOTIFICATION_LEVEL,
      mutedUntil:
        patch.mutedUntil !== undefined
          ? patch.mutedUntil
          : (existing?.mutedUntil ?? null),
      suppressEveryone:
        patch.suppressEveryone ??
        existing?.suppressEveryone ??
        false,
      suppressRoles:
        patch.suppressRoles ?? existing?.suppressRoles ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        spaceMemberNotificationSettingsTable.userId,
        spaceMemberNotificationSettingsTable.spaceId,
      ],
      set: {
        ...(patch.level !== undefined ? { level: patch.level } : {}),
        ...(patch.mutedUntil !== undefined
          ? { mutedUntil: patch.mutedUntil }
          : {}),
        ...(patch.suppressEveryone !== undefined
          ? { suppressEveryone: patch.suppressEveryone }
          : {}),
        ...(patch.suppressRoles !== undefined
          ? { suppressRoles: patch.suppressRoles }
          : {}),
        updatedAt: new Date(),
      },
    })
    .returning();

  return serializeSpaceNotificationSettings(row);
}

type ResolvedChannelNotification = {
  level: NotificationLevel;
  suppress: NotificationSuppressOptions;
};

export async function resolveChannelNotificationForUser(
  userId: string,
  channelId: string,
  spaceId: string | null | undefined,
): Promise<ResolvedChannelNotification> {
  const readState = await db.query.readStatesTable.findFirst({
    where: and(
      eq(readStatesTable.userId, BigInt(userId)),
      eq(readStatesTable.channelId, BigInt(channelId)),
      eq(readStatesTable.type, ReadStateType.Messages),
    ),
  });

  const spaceSettings = spaceId
    ? await getSpaceNotificationSettings(userId, spaceId)
    : null;

  const level = resolveEffectiveNotificationLevel({
    spaceLevel: spaceSettings?.level ?? null,
    spaceMutedUntil: spaceSettings?.mutedUntil ?? null,
    channelLevel:
      readState?.notificationLevel == null
        ? null
        : (readState.notificationLevel as NotificationLevel),
    channelMutedUntil: readState?.mutedUntil ?? null,
  });

  return {
    level,
    suppress: {
      suppressEveryone: spaceSettings?.suppressEveryone ?? false,
      suppressRoles: spaceSettings?.suppressRoles ?? false,
    },
  };
}

export async function filterUsersForMessageNotification(
  userIds: string[],
  channelId: string,
  spaceId: string | null | undefined,
  ctx: NotificationMessageContext,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const unique = Array.from(new Set(userIds));
  const results: string[] = [];

  await Promise.all(
    unique.map(async (userId) => {
      const resolved = await resolveChannelNotificationForUser(
        userId,
        channelId,
        spaceId,
      );
      if (
        shouldDeliverMessageNotification(
          resolved.level,
          ctx,
          resolved.suppress,
        )
      ) {
        results.push(userId);
      }
    }),
  );

  return results;
}

export async function filterUsersForMentionCount(
  userIds: string[],
  channelId: string,
  spaceId: string | null | undefined,
  ctx: NotificationMessageContext,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const unique = Array.from(new Set(userIds));
  const results: string[] = [];

  await Promise.all(
    unique.map(async (userId) => {
      const resolved = await resolveChannelNotificationForUser(
        userId,
        channelId,
        spaceId,
      );
      if (
        shouldIncrementMentionCount(resolved.level, ctx, resolved.suppress)
      ) {
        results.push(userId);
      }
    }),
  );

  return results;
}

export async function getAllMessagePushRecipientIds(
  spaceId: string,
  channelId: string,
  authorId: string,
): Promise<string[]> {
  const memberRows = await db
    .select({ userId: spaceMembersTable.userId })
    .from(spaceMembersTable)
    .where(
      and(
        eq(spaceMembersTable.spaceId, BigInt(spaceId)),
        ne(spaceMembersTable.userId, BigInt(authorId)),
      ),
    );

  const memberIds = memberRows.map((row) => row.userId.toString());
  if (memberIds.length === 0) return [];

  return filterUsersForMessageNotification(memberIds, channelId, spaceId, {
    isDirectMention: false,
    isRoleMention: false,
    isEveryoneMention: false,
    isHereMention: false,
    isRegularMessage: true,
  });
}

export { computeMutedUntilDuration, isNotificationMuteActive };
