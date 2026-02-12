import { getCache, setCache } from "@mutualzz/cache";
import {
    channelPermissionOverwritesTable,
    channelsTable,
    db,
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
    roleFlags,
    type APIChannel,
    type APIPrivateUser,
    type APISpace,
    type APISpaceMember,
    type APITheme,
    type APIUser,
    type APIUserSettings,
    type Snowflake,
} from "@mutualzz/types";
import { execNormalized, execNormalizedMany } from "@mutualzz/util";
import { and, eq, or, sql } from "drizzle-orm";

export const prepareReadyData = async (user: APIPrivateUser) => {
    const [themes, settings] = await Promise.all([
        execNormalizedMany<APITheme>(
            db.query.themesTable.findMany({
                with: {
                    author: true,
                },
                where: eq(themesTable.authorId, BigInt(user.id)),
            }),
        ),
        execNormalized<APIUserSettings>(
            db.query.userSettingsTable.findFirst({
                where: eq(userSettingsTable.userId, BigInt(user.id)),
            }),
        ),
    ]);

    const spaces = await execNormalizedMany<APISpace>(
        db.query.spacesTable.findMany({
            with: {
                members: {
                    with: {
                        user: {
                            columns: {
                                hash: false,
                                dateOfBirth: false,
                                previousAvatars: false,
                                email: false,
                            },
                        },
                    },
                },
                channels: {
                    with: {
                        parent: true,
                        lastMessage: {
                            with: {
                                author: {
                                    columns: {
                                        hash: false,
                                        dateOfBirth: false,
                                        previousAvatars: false,
                                        email: false,
                                    },
                                },
                            },
                        },
                    },
                },
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
    );

    return {
        user,
        themes,
        spaces,
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
    if (!privateUser) user = await getCache("user", id);
    else user = await getCache("authUser", id);
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

export const getChannel = async (id: string) => {
    let channel = await getCache("channel", id);
    if (channel) return channel;

    channel = await execNormalized<APIChannel>(
        db.query.channelsTable.findFirst({
            where: eq(channelsTable.id, BigInt(id)),
        }),
    );

    if (!channel) return null;

    await setCache("channel", id, channel);
    return channel;
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
    let member = await getCache("spaceMember", cacheKey);

    if (member) return member;

    if (justChecking) {
        const exists = await execNormalized<APISpaceMember>(
            db.query.spaceMembersTable.findFirst({
                columns: {
                    userId: true,
                },
                where: and(
                    eq(spaceMembersTable.spaceId, BigInt(spaceId)),
                    eq(spaceMembersTable.userId, BigInt(userId)),
                ),
            }),
        );

        return !!exists;
    }

    member = await execNormalized<APISpaceMember>(
        db.query.spaceMembersTable.findFirst({
            with: {
                space: true,
            },
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
    return db
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
        .catch(() => null);
}

export async function getMemberRoles(spaceId: Snowflake, userId: Snowflake) {
    return db
        .select({
            id: rolesTable.id,
            permissions: rolesTable.permissions,
            flags: rolesTable.flags,
            position: rolesTable.position,
        })
        .from(spaceMemberRolesTable)
        .innerJoin(rolesTable, eq(spaceMemberRolesTable.id, rolesTable.id))
        .where(
            and(
                eq(spaceMemberRolesTable.spaceId, BigInt(spaceId)),
                eq(spaceMemberRolesTable.userId, BigInt(userId)),
            ),
        );
}

export async function getChannelOverwrites(channelId: Snowflake) {
    return db
        .select({
            roleId: channelPermissionOverwritesTable.roleId,
            userId: channelPermissionOverwritesTable.userId,
            allow: channelPermissionOverwritesTable.allow,
            deny: channelPermissionOverwritesTable.deny,
        })
        .from(channelPermissionOverwritesTable)
        .where(
            eq(channelPermissionOverwritesTable.channelId, BigInt(channelId)),
        );
}
