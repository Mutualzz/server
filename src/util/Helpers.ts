import { getCache, setCache } from "@mutualzz/cache";
import {
  channelMemberOverwritesTable,
  channelRecipientsTable,
  channelRoleOverwritesTable,
  channelsTable,
  db,
  expressionsTable,
  relationshipsTable,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  spacesTable,
  themesTable,
  toPublicUser,
  userSettingsTable,
  usersTable,
} from "@mutualzz/database";
import {
  type APIChannel,
  type APIExpression,
  type APIPrivateUser,
  type APIReadState,
  type APIRelationship,
  type APISpace,
  type APISpaceMember,
  type APITheme,
  type APIUser,
  type APIUserSettings,
  ExpressionType,
  HttpException,
  HttpStatusCode,
  type PresencePayload,
  ReadStateType,
  type Snowflake,
} from "@mutualzz/types";
import { execNormalized, execNormalizedMany } from "@mutualzz/util";
import { and, eq, or, sql } from "drizzle-orm";
import { roleFlags } from "@mutualzz/bitfield";
import { perspectiveForUser } from "@mutualzz/rest/util";
import { attachPresenceUser } from "@mutualzz/gateway/util/Calculations.ts";
import { readStatesTable } from "@mutualzz/database/schemas/ReadState.ts";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service.ts";

function normalizeOverwrite(ow: any, extra: Record<string, any> = {}) {
  return {
    ...ow,
    channelId: ow.channelId != null ? String(ow.channelId) : null,
    spaceId: ow.spaceId != null ? String(ow.spaceId) : null,
    roleId: ow.roleId != null ? String(ow.roleId) : null,
    userId: ow.userId != null ? String(ow.userId) : null,
    allow: ow.allow != null ? String(ow.allow) : "0",
    deny: ow.deny != null ? String(ow.deny) : "0",
    ...extra,
  };
}

export const resolveExpressions = async (
  content: string | null,
  expressionIds?: (string | bigint)[] | null,
): Promise<APIExpression[]> => {
  const fromContent = (content?.match(/<a?:[^:]+:(\d+)>/g) ?? [])
    .map((raw) => raw.match(/<a?:[^:]+:(\d+)>/)?.[1])
    .filter(Boolean) as string[];

  const fromIds = (expressionIds ?? []).map((id) => id.toString());
  const unique = [...new Set([...fromContent, ...fromIds])];

  if (!unique.length) return [];

  return (await Promise.all(unique.map((id) => getExpression(id)))).filter(
    (exp): exp is APIExpression => !!exp,
  );
};

const MAX_MESSAGE_STICKERS = 3;

export const validateMessageStickers = async ({
  expressionIds,
  channel,
  userId,
  canUseExternalStickers,
}: {
  expressionIds: string[];
  channel: APIChannel;
  userId: string;
  canUseExternalStickers: boolean;
}): Promise<bigint[]> => {
  if (!expressionIds.length) return [];

  if (expressionIds.length > MAX_MESSAGE_STICKERS) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `You can only attach up to ${MAX_MESSAGE_STICKERS} stickers`,
    );
  }

  const unique = [...new Set(expressionIds)];
  const validated: bigint[] = [];

  for (const id of unique) {
    const expression = await getExpression(id);

    if (!expression)
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "One or more stickers could not be found",
      );

    if (expression.type !== ExpressionType.Sticker)
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "Only stickers can be attached to messages",
      );

    let allowed = false;

    if (!expression.spaceId && expression.authorId === userId) {
      allowed = true;
    } else if (
      channel.spaceId &&
      expression.spaceId &&
      expression.spaceId === channel.spaceId
    ) {
      allowed = true;
    } else if (canUseExternalStickers) {
      allowed = true;
    }

    if (!allowed)
      throw new HttpException(
        HttpStatusCode.Forbidden,
        `You cannot use the sticker :${expression.name}:`,
      );

    validated.push(BigInt(id));
  }

  return validated;
};

export const publicUserColumns = {
  hash: false,
  dateOfBirth: false,
  previousAvatars: false,
  email: false,
} as const;

export async function isChannelRecipient(channelId: string, userId: string) {
  const cacheKey = `${channelId}:${userId}`;

  const cached = await getCache("channelRecipient", cacheKey);
  if (typeof cached === "boolean") return cached;

  const row = await db.query.channelRecipientsTable.findFirst({
    columns: { userId: true },
    where: and(
      eq(channelRecipientsTable.channelId, BigInt(channelId)),
      eq(channelRecipientsTable.userId, BigInt(userId)),
    ),
  });

  const isRecipient = !!row;
  await setCache("channelRecipient", cacheKey, isRecipient);
  return isRecipient;
}

export async function getBulkPresences(
  userIds: string[],
): Promise<Record<string, PresencePayload>> {
  const results = await Promise.all(
    userIds.map(async (id) => {
      const presence = await PresenceService.get(id);
      return [id, presence] as const;
    }),
  );

  return Object.fromEntries(
    results.filter(
      (entry): entry is [string, PresencePayload] => entry[1] !== null,
    ),
  );
}

export const prepareReadyData = async (user: APIPrivateUser) => {
  const [
    themes,
    spaces,
    dmChannels,
    relationships,
    expressions,
    settings,
    readStates,
  ] = await Promise.all([
    // Get all themes owned by the user
    execNormalizedMany<APITheme>(
      db.query.themesTable.findMany({
        with: {
          author: {
            columns: publicUserColumns,
          },
        },
        where: eq(themesTable.authorId, BigInt(user.id)),
      }),
    ),

    await db.query.spacesTable
      .findMany({
        with: {
          members: {
            with: {
              user: { columns: publicUserColumns },
              roles: true,
            },
          },
          channels: {
            with: {
              parent: true,
              roleOverwrites: true,
              memberOverwrites: true,
              space: true,
            },
          },
          roles: true,
          owner: {
            columns: publicUserColumns,
          },
        },
        where: or(
          eq(spacesTable.ownerId, BigInt(user.id)),
          sql`exists (
                    select 1 from "space_members" sm
                    where sm."spaceId" = ${spacesTable.id}
                    and sm."userId" = ${BigInt(user.id)}
                )`,
        ),
      })
      .then((rawSpaces) =>
        execNormalizedMany<APISpace>(
          Promise.resolve(
            rawSpaces.map((space) => ({
              ...space,
              channels: space.channels.map((ch) => ({
                ...ch,
                overwrites: [
                  ...ch.roleOverwrites.map((ow) =>
                    normalizeOverwrite(ow, { userId: null }),
                  ),
                  ...ch.memberOverwrites.map((ow) =>
                    normalizeOverwrite(ow, { roleId: null }),
                  ),
                ],
                roleOverwrites: undefined,
                memberOverwrites: undefined,
              })),
            })),
          ),
        ),
      ),

    // Get all the DM Channels
    execNormalizedMany(
      db.query.channelRecipientsTable.findMany({
        where: and(
          eq(channelRecipientsTable.userId, BigInt(user.id)),
          eq(channelRecipientsTable.closed, false),
        ),
        with: {
          channel: {
            with: {
              recipients: {
                with: {
                  user: { columns: publicUserColumns },
                },
              },
            },
          },
        },
      }),
    ),

    execNormalizedMany<APIRelationship>(
      db.query.relationshipsTable.findMany({
        where: or(
          eq(relationshipsTable.userId, BigInt(user.id)),
          eq(relationshipsTable.otherUserId, BigInt(user.id)),
        ),
      }),
    ),

    // Get expressions that a user can access to or is owner of
    execNormalizedMany<APIExpression>(
      db.query.expressionsTable.findMany({
        where: or(
          eq(expressionsTable.authorId, BigInt(user.id)),
          sql`exists (
                        select 1 from "space_members" sm
                        where sm."spaceId" = ${expressionsTable.spaceId}
                        and sm."userId" = ${BigInt(user.id)}
                    )`,
        ),
      }),
    ),

    // Get user settings
    execNormalized<APIUserSettings>(
      db.query.userSettingsTable.findFirst({
        where: eq(userSettingsTable.userId, BigInt(user.id)),
      }),
    ),
    getReadStates(user.id),
  ]);

  const presenceUserIds = new Set<string>();

  for (const row of dmChannels) {
    for (const r of row.channel.recipients) {
      if (r.user.id !== user.id) presenceUserIds.add(r.user.id);
    }
  }

  for (const r of relationships) {
    const otherId = r.userId === user.id ? r.otherUserId : r.userId;
    presenceUserIds.add(otherId);
  }

  const mergedPresences = await getBulkPresences([...presenceUserIds]);

  const channels: APIChannel[] = (await Promise.all(
    dmChannels.map(async (row) => ({
      ...row.channel,
      recipients: await Promise.all(
        row.channel.recipients.map(
          async (r: any) => await attachPresenceUser(r.user),
        ),
      ),
      recipientIds: row.channel.recipients.map((r: any) => r.user.id),
    })),
  )) satisfies APIChannel[];

  const relationshipsForReady = relationships.map((r) =>
    perspectiveForUser(r, user.id),
  );

  return {
    user,
    themes,
    spaces,
    channels,
    relationships: relationshipsForReady,
    expressions,
    settings,
    readStates,
    mergedPresences,
  };
};

export async function getReadStates(userId: string): Promise<APIReadState[]> {
  const rows = await db
    .select()
    .from(readStatesTable)
    .where(eq(readStatesTable.userId, BigInt(userId)));

  return rows.map((r) => ({
    ...r,
    id: r.channelId.toString(),
    lastMessageId: r.lastMessageId?.toString() ?? null,
    notificationsCursor: r.notificationsCursor?.toString() ?? null,
    lastAckedId: r.lastAckedId?.toString() ?? null,
  })) satisfies APIReadState[];
}

export async function incrementMentionCounts(
  channelId: string,
  userIds: string[],
  roleIds?: string[],
) {
  const mentionedUserIds = Array.from(new Set(userIds));
  let allUserIds = [...mentionedUserIds];

  if (roleIds && roleIds.length > 0) {
    const uniqueRoleIds = Array.from(new Set(roleIds));

    const roleMembers = await db
      .select({ userId: spaceMemberRolesTable.userId })
      .from(spaceMemberRolesTable)
      .where(
        sql`${spaceMemberRolesTable.roleId} = ANY(ARRAY[${sql.raw(uniqueRoleIds.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
      );

    const roleMemberIds = roleMembers.map((r) => r.userId.toString());
    allUserIds = Array.from(new Set([...allUserIds, ...roleMemberIds]));
  }

  if (allUserIds.length === 0) return;

  await db
    .insert(readStatesTable)
    .values(
      allUserIds.map((uid) => ({
        userId: BigInt(uid),
        channelId: BigInt(channelId),
        type: ReadStateType.Messages,
        mentionCount: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [
        readStatesTable.userId,
        readStatesTable.channelId,
        readStatesTable.type,
      ],
      set: {
        mentionCount: sql`read_states."mentionCount" + 1`,
      },
    });
}

export const getChannels = async (ids: string[]) => {
  const result = new Map<string, APIChannel>();
  const misses: string[] = [];

  // Check cache first for each id
  await Promise.all(
    ids.map(async (id) => {
      const cached = await getCache("channel", id);
      if (cached) result.set(id, cached);
      else misses.push(id);
    }),
  );

  if (misses.length === 0) return result;

  const rows = await execNormalizedMany<APIChannel>(
    db.query.channelsTable.findMany({
      where: sql`${channelsTable.id} = ANY(ARRAY[${sql.raw(misses.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
      with: {
        recipients: {
          with: {
            user: { columns: publicUserColumns },
          },
        },
        roleOverwrites: true,
        memberOverwrites: true,
      },
    }),
  );

  await Promise.all(
    rows.map(async (row) => {
      const hydrated: APIChannel = {
        ...row,
        overwrites: [
          ...((row as any).roleOverwrites ?? []).map((ow: any) =>
            normalizeOverwrite(ow, { userId: null }),
          ),
          ...((row as any).memberOverwrites ?? []).map((ow: any) =>
            normalizeOverwrite(ow, { roleId: null }),
          ),
        ],
        recipients: row.recipients
          ? await Promise.all(
              row.recipients.map((r: any) => attachPresenceUser(r.user)),
            )
          : null,
      };

      const id = row.id.toString();
      await setCache("channel", id, hydrated);
      result.set(id, hydrated);
    }),
  );

  return result;
};

export const isSnowflakeIdentifier = (value: string) => /^\d{15,}$/.test(value);

export async function getUserByUsername(
  username: string,
  privateUser = false,
): Promise<APIUser | APIPrivateUser | null> {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return null;

  const user = await execNormalized<APIUser | APIPrivateUser | null>(
    db.query.usersTable.findFirst({
      columns: {
        hash: false,
      },
      where: eq(usersTable.username, normalized),
    }),
  );

  if (!user) return null;

  const resolved = !privateUser ? toPublicUser(user as APIPrivateUser) : user;

  if ("hash" in resolved) delete resolved.hash;
  if ("token" in resolved) delete resolved.token;

  if (resolved.id) {
    if (privateUser)
      await setCache("authUser", resolved.id, resolved as APIPrivateUser);
    else await setCache("user", resolved.id, resolved);
  }

  return resolved;
}

export async function resolveUserIdentifier(
  identifier: string,
  privateUser = false,
): Promise<APIUser | APIPrivateUser | null> {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return null;

  if (isSnowflakeIdentifier(normalized)) {
    const byId = privateUser
      ? await getUser(normalized, true)
      : await getUser(normalized);
    if (byId) return byId;
  }

  const byUsername = await getUserByUsername(normalized, privateUser);
  if (byUsername) return byUsername;

  if (/^\d+$/.test(normalized)) {
    return privateUser ? getUser(normalized, true) : getUser(normalized);
  }

  return null;
}

export async function getUser(
  id: string,
  privateUser: true,
): Promise<APIPrivateUser | null>;
export async function getUser(
  id: string,
  privateUser?: false,
): Promise<APIUser | null>;
export async function getUser(
  id?: string,
  privateUser = false,
): Promise<APIUser | null> {
  if (!id) return null;

  let user: APIUser | APIPrivateUser | null;
  if (privateUser) user = await getCache("authUser", id);
  else user = await getCache("user", id);
  if (user) return user;

  user = await execNormalized<APIUser | APIPrivateUser>(
    db.query.usersTable.findFirst({
      columns: {
        hash: false,
      },
      where: eq(usersTable.id, BigInt(id)),
    }),
  );

  if (!user) return null;

  if (!privateUser) user = toPublicUser(user as APIPrivateUser);

  if ("hash" in user) delete user.hash;
  if ("token" in user) delete user.token;

  if (privateUser) await setCache("authUser", id, user as APIPrivateUser);
  else await setCache("user", id, user);

  return user;
}

export const getSpace = async (id: string) => {
  let space = await getCache("space", id);
  if (space) return space;

  space = await execNormalized<APISpace>(
    db.query.spacesTable.findFirst({
      where: eq(spacesTable.id, BigInt(id)),
    }),
  );

  if (!space) return null;

  await setCache("space", id, space);
  return space;
};

export const getSpaceHydrated = async (id: string) => {
  let space = await getCache("spaceHydrated", id);
  if (space) return space;

  const raw = await db.query.spacesTable.findFirst({
    with: {
      roles: true,
      members: {
        with: {
          user: {
            columns: publicUserColumns,
          },
          roles: {
            with: {
              role: true,
            },
          },
        },
      },
      channels: {
        with: {
          parent: true,
          roleOverwrites: true,
          memberOverwrites: true,
        },
      },
      owner: { columns: publicUserColumns },
    },
    where: eq(spacesTable.id, BigInt(id)),
  });

  if (!raw) return null;

  space = await execNormalized<APISpace>(
    Promise.resolve({
      ...raw,
      channels: raw.channels.map((ch) => ({
        ...ch,
        overwrites: [
          ...ch.roleOverwrites.map((ow) =>
            normalizeOverwrite(ow, { userId: null }),
          ),
          ...ch.memberOverwrites.map((ow) =>
            normalizeOverwrite(ow, { roleId: null }),
          ),
        ],
        roleOverwrites: undefined,
        memberOverwrites: undefined,
      })),
    }),
  );

  if (!space) return null;

  await setCache("spaceHydrated", id, space);
  return space;
};

export const getChannel = async (id: string) => {
  const channel = await getCache("channel", id);
  if (channel) return channel;

  const row = await execNormalized<APIChannel>(
    db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, BigInt(id)),
      with: {
        recipients: {
          with: {
            user: { columns: publicUserColumns },
          },
        },
        roleOverwrites: true,
        memberOverwrites: true,
      },
    }),
  );

  if (!row) return null;

  const hydrated: APIChannel = {
    ...row,
    overwrites: [
      ...((row as any).roleOverwrites ?? []).map((ow: any) =>
        normalizeOverwrite(ow, { userId: null }),
      ),
      ...((row as any).memberOverwrites ?? []).map((ow: any) =>
        normalizeOverwrite(ow, { roleId: null }),
      ),
    ],
    recipientIds:
      row.recipients?.map((r: any) => r.user.id) ?? row.recipientIds ?? null,
    recipients: row.recipients
      ? await Promise.all(
          row.recipients.map((r: any) => attachPresenceUser(r.user)),
        )
      : null,
  };

  await setCache("channel", id, hydrated);
  return hydrated;
};

export const getExpression = async (id: string) => {
  let expression = await getCache("expression", id);
  if (expression) return expression;

  expression = await execNormalized<APIExpression>(
    db.query.expressionsTable.findFirst({
      where: eq(expressionsTable.id, BigInt(id)),
    }),
  );

  if (!expression) return null;

  await setCache("expression", id, expression);
  return expression;
};

export async function getMember(
  spaceId: Snowflake,
  userId: Snowflake,
  justChecking: true,
): Promise<boolean>;
export async function getMember(
  spaceId: Snowflake,
  userId: Snowflake,
  justChecking?: false,
): Promise<APISpaceMember | null>;
export async function getMember(
  spaceId: Snowflake,
  userId: Snowflake,
  justChecking = false,
): Promise<boolean | APISpaceMember | null> {
  const cacheKey = `${spaceId}:${userId}`;

  // If caller only wants existence, do not return cached object.
  if (justChecking) {
    const exists = await execNormalized<APISpaceMember>(
      db.query.spaceMembersTable.findFirst({
        columns: { userId: true },
        where: and(
          eq(spaceMembersTable.spaceId, BigInt(spaceId)),
          eq(spaceMembersTable.userId, BigInt(userId)),
        ),
      }),
    );
    return !!exists;
  }

  const cached = await getCache("spaceMember", cacheKey);
  if (cached) return cached;

  const member = await execNormalized<APISpaceMember>(
    db.query.spaceMembersTable.findFirst({
      with: { space: true },
      where: and(
        eq(spaceMembersTable.spaceId, BigInt(spaceId)),
        eq(spaceMembersTable.userId, BigInt(userId)),
      ),
    }),
  );

  if (!member) return null;

  await setCache("spaceMember", cacheKey, member);
  return member;
}

export async function getEveryoneRole(spaceId: Snowflake) {
  let role = await getCache("everyoneRole", spaceId);
  if (role) return role;

  role = await execNormalized(
    db
      .select({
        id: rolesTable.id,
        allow: rolesTable.allow,
        deny: rolesTable.deny,
        flags: rolesTable.flags,
        position: rolesTable.position,
      })
      .from(rolesTable)
      .where(
        and(
          eq(rolesTable.spaceId, BigInt(spaceId)),
          sql`${rolesTable.flags} & ${roleFlags.Everyone} = ${roleFlags.Everyone}`,
        ),
      )
      .limit(1)
      .then((res) => res[0])
      .catch(() => null),
  );

  if (!role) return null;

  await setCache("everyoneRole", spaceId, role);
  return role;
}

export async function getMemberRoles(spaceId: Snowflake, userId: Snowflake) {
  const cacheKey = `${spaceId}:${userId}`;
  let memberRoles = await getCache("memberRoles", cacheKey);
  if (memberRoles) return memberRoles;

  const rows = await db
    .select({
      id: rolesTable.id,
      allow: rolesTable.allow,
      deny: rolesTable.deny,
      flags: rolesTable.flags,
      position: rolesTable.position,
    })
    .from(spaceMemberRolesTable)
    .innerJoin(rolesTable, eq(spaceMemberRolesTable.roleId, rolesTable.id))
    .where(
      and(
        eq(spaceMemberRolesTable.spaceId, BigInt(spaceId)),
        eq(spaceMemberRolesTable.userId, BigInt(userId)),
      ),
    );

  memberRoles = rows.map((r) => ({
    ...r,
    id: r.id.toString(),
  }));

  await setCache("memberRoles", cacheKey, memberRoles);
  return memberRoles;
}

export async function getChannelOverwrites(
  spaceId: Snowflake,
  channelId: Snowflake,
) {
  const cacheKey = `${spaceId}:${channelId}`;
  let overwrites = await getCache("channelOverwrites", cacheKey);
  if (overwrites) return overwrites;

  const [roleRows, memberRows] = await Promise.all([
    db
      .select({
        roleId: channelRoleOverwritesTable.roleId,
        allow: channelRoleOverwritesTable.allow,
        deny: channelRoleOverwritesTable.deny,
      })
      .from(channelRoleOverwritesTable)
      .where(
        and(
          eq(channelRoleOverwritesTable.spaceId, BigInt(spaceId)),
          eq(channelRoleOverwritesTable.channelId, BigInt(channelId)),
        ),
      ),
    db
      .select({
        userId: channelMemberOverwritesTable.userId,
        allow: channelMemberOverwritesTable.allow,
        deny: channelMemberOverwritesTable.deny,
      })
      .from(channelMemberOverwritesTable)
      .where(
        and(
          eq(channelMemberOverwritesTable.spaceId, BigInt(spaceId)),
          eq(channelMemberOverwritesTable.channelId, BigInt(channelId)),
        ),
      ),
  ]);

  overwrites = [
    ...roleRows.map((row) => ({
      roleId: row.roleId.toString(),
      userId: null,
      allow: row.allow,
      deny: row.deny,
    })),
    ...memberRows.map((row) => ({
      roleId: null,
      userId: row.userId.toString(),
      allow: row.allow,
      deny: row.deny,
    })),
  ];

  await setCache("channelOverwrites", cacheKey, overwrites);
  return overwrites;
}
