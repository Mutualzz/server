import { getCache, setCache } from "@mutualzz/cache";
import {
    channelPermissionOverwritesTable,
    channelRecipientsTable,
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
import type {
    APIExpression,
    APIRelationship,
    APIUserSettings,
} from "@mutualzz/types";
import {
    type APIChannel,
    type APIPrivateUser,
    type APISpace,
    type APISpaceMember,
    type APITheme,
    type APIUser,
    type Snowflake,
} from "@mutualzz/types";
import { execNormalized, execNormalizedMany } from "@mutualzz/util";
import { and, eq, or, sql } from "drizzle-orm";
import { roleFlags } from "@mutualzz/bitfield";
import { perspectiveForUser } from "@mutualzz/rest/util";

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

export const prepareReadyData = async (user: APIPrivateUser) => {
    const [themes, spaces, dmChannels, relationships, expressions, settings] =
        await Promise.all([
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

            // Get all spaces that the user is part of or is owner of.
            execNormalizedMany<APISpace>(
                db.query.spacesTable.findMany({
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
                                overwrites: true,
                                space: true,
                            },
                        },
                        roles: true,
                        owner: true,
                    },
                    where: or(
                        eq(spacesTable.ownerId, BigInt(user.id)),
                        sql`exists (
                    select 1 from "space_members" sm
                    where sm."spaceId" = ${spacesTable.id}
                    and sm."userId" = ${BigInt(user.id)}
                )`,
                    ),
                }),
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
                    where sm."spaceId" = ${spacesTable.id}
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
        ]);

    const channels: APIChannel[] = dmChannels.map((row) => ({
        ...row.channel,
        recipients: row.channel.recipients.map((r: any) => r.user),
        recipientIds: row.channel.recipients.map((r: any) => r.user.id),
    })) satisfies APIChannel[];

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
    };
};

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

    space = await execNormalized<APISpace>(
        db.query.spacesTable.findFirst({
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
                        overwrites: true,
                    },
                },
                owner: { columns: publicUserColumns },
            },
            where: eq(spacesTable.id, BigInt(id)),
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
            },
        }),
    );

    if (!row) return null;

    const hydrated: APIChannel = {
        ...row,
        recipientIds:
            row.recipients?.map((r: any) => r.user.id) ??
            row.recipientIds ??
            null,
        recipients: row.recipients?.map((r: any) => r.user) ?? null,
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
                permissions: rolesTable.permissions,
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
            permissions: rolesTable.permissions,
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

    const rows = await db
        .select({
            roleId: channelPermissionOverwritesTable.roleId,
            userId: channelPermissionOverwritesTable.userId,
            allow: channelPermissionOverwritesTable.allow,
            deny: channelPermissionOverwritesTable.deny,
        })
        .from(channelPermissionOverwritesTable)
        .where(
            and(
                eq(channelPermissionOverwritesTable.spaceId, BigInt(spaceId)),
                eq(
                    channelPermissionOverwritesTable.channelId,
                    BigInt(channelId),
                ),
            ),
        );

    overwrites = rows.map((row) => ({
        roleId: row.roleId ? row.roleId.toString() : null,
        userId: row.userId ? row.userId.toString() : null,
        allow: row.allow,
        deny: row.deny,
    }));

    await setCache("channelOverwrites", cacheKey, overwrites);
    return overwrites;
}
