import {
    deleteCache,
    getCache,
    invalidateCache,
    setCache,
} from "@mutualzz/cache";
import {
    channelsTable,
    db,
    invitesTable,
    messagesTable,
    rolesTable,
    spaceMemberRolesTable,
    spaceMembersTable,
    toPublicUser,
    userSettingsTable,
} from "@mutualzz/database";
import {
    type APIChannel,
    type APIMessage,
    type APISpaceMember,
    type APIUserSettings,
    HttpException,
    HttpStatusCode,
} from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    filterVisibleChannelsForUser,
    getMember,
    getMemberRoles,
    getSpaceHydrated,
    publicUserColumns,
    requireSpacePermissions,
} from "@mutualzz/util";
import {
    validateMemberBanBody,
    validateMembersActionParams,
    validateMembersAddParams,
    validateMembersGetAllParams,
    validateMembersGetAllQuery,
    validateMembersRemoveMeParams,
    validateMemberVoiceModerationBody,
    validateRoleMemberParams,
} from "@mutualzz/validators";
import { and, eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { BitField, memberFlags, permissionFlags } from "@mutualzz/permissions";
import dayjs from "dayjs";
import { VoiceStateService } from "@mutualzz/gateway/voice/VoiceState.service.ts";

function topPos(rows: { position: number }[]) {
    let t = -1;
    for (const r of rows) t = Math.max(t, r.position);
    return t;
}

export default class MembersController {
    static async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateMembersGetAllParams.parse(req.params);
            const { limit } = validateMembersGetAllQuery.parse(req.query);

            const space = await getSpaceHydrated(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const me = await getMember(space.id, user.id);
            if (!me)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not a member of this space",
                );

            const visibleChannels = filterVisibleChannelsForUser(
                space,
                BigInt(user.id),
            );

            if (visibleChannels.length === 0)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have access to any channels in this space",
                );

            let members = await getCache("spaceMembers", space.id);
            if (!members)
                members = await execNormalizedMany<APISpaceMember>(
                    db.query.spaceMembersTable.findMany({
                        with: {
                            user: {
                                with: publicUserColumns,
                            },
                        },
                        where: eq(spaceMembersTable.spaceId, BigInt(space.id)),
                        limit,
                    }),
                );

            return res.status(HttpStatusCode.Success).json(members);
        } catch (err) {
            next(err);
        }
    }

    static async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId } = validateMembersActionParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const me = await getMember(space.id, user.id);
            if (!me)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "Not a member of this space",
                );

            const visibleChannels = filterVisibleChannelsForUser(
                space,
                BigInt(user.id),
            );

            if (visibleChannels.length === 0)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have access to any channels in this space",
                );

            const member = await getMember(space.id, userId || user.id);
            if (!member)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            return res.status(HttpStatusCode.Success).json(member);
        } catch (err) {
            next(err);
        }
    }

    static async addMe(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateMembersAddParams.parse(req.params);

            const space = await getSpaceHydrated(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const member = await getMember(space.id, user.id);
            if (member) return res.status(HttpStatusCode.Success).json(member);

            const { channelId, code } = req.body;

            const findInvite = await db.query.invitesTable.findFirst({
                where: and(
                    eq(invitesTable.code, code),
                    eq(invitesTable.channelId, BigInt(channelId)),
                    eq(invitesTable.spaceId, BigInt(space.id)),
                ),
            });

            if (!findInvite)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid invite code",
                );

            const newMember = await execNormalized<APISpaceMember>(
                db
                    .insert(spaceMembersTable)
                    .values({
                        spaceId: BigInt(space.id),
                        userId: BigInt(user.id),
                        joinedAt: new Date(),
                    })
                    .returning()
                    .then((r) => r[0]),
            );

            if (!newMember)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to add member to space",
                );

            await db.insert(spaceMemberRolesTable).values({
                roleId: BigInt(space.id),
                userId: BigInt(user.id),
                spaceId: BigInt(space.id),
            });

            let members = await getCache("spaceMembers", space.id);
            let channels = await getCache("channels", space.id);
            if (!channels)
                channels = await execNormalizedMany<APIChannel>(
                    db.query.channelsTable.findMany({
                        where: eq(channelsTable.spaceId, BigInt(space.id)),
                        with: {
                            parent: true,
                            lastMessage: {
                                with: {
                                    author: {
                                        columns: publicUserColumns,
                                    },
                                },
                            },
                        },
                    }),
                );

            if (!members)
                members = await execNormalizedMany<APISpaceMember>(
                    db.query.spaceMembersTable.findMany({
                        with: {
                            user: {
                                columns: publicUserColumns,
                            },
                            roles: true,
                        },
                        where: eq(spaceMembersTable.spaceId, BigInt(space.id)),
                    }),
                );

            await setCache("spaceMember", `${space.id}:${user.id}`, newMember);
            await setCache("channels", space.id, channels);
            await setCache("spaceMembers", space.id, members);

            await emitEvent({
                event: "SpaceMemberAdd",
                space_id: space.id,
                data: newMember,
            });

            await emitEvent({
                event: "SpaceCreate",
                user_id: user.id,
                data: {
                    ...space,
                    members,
                    channels,
                    memberCount: members.length + 1,
                },
            });

            const settings = await execNormalized<APIUserSettings>(
                db
                    .insert(userSettingsTable)
                    .values({
                        userId: BigInt(user.id),
                        spacePositions: [BigInt(space.id)],
                    })
                    .onConflictDoUpdate({
                        target: userSettingsTable.userId,
                        set: {
                            spacePositions: sql`array_prepend(${space.id}, COALESCE(${userSettingsTable.spacePositions}, ARRAY[]::bigint[]))`,
                        },
                    })
                    .returning()
                    .then((results) => results[0]),
            );

            if (settings) {
                await setCache("userSettings", user.id, settings);
                await emitEvent({
                    event: "UserSettingsUpdate",
                    user_id: user.id,
                    data: settings,
                });
            }

            await invalidateCache("spaceHydrated", spaceId);

            res.status(HttpStatusCode.Created).json(newMember);
        } catch (err) {
            next(err);
        }
    }

    static async removeMe(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateMembersRemoveMeParams.parse(req.params);

            const space = await getSpaceHydrated(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) === BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Space owner cannot leave the space",
                );

            const member = await getMember(space.id, user.id);
            if (!member)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "You are not a member of this space",
                );

            await db
                .delete(spaceMembersTable)
                .where(
                    and(
                        eq(spaceMembersTable.spaceId, BigInt(space.id)),
                        eq(spaceMembersTable.userId, BigInt(member.userId)),
                    ),
                );

            await deleteCache("spaceMember", `${space.id}:${member.userId}`);
            await invalidateCache("spaceMembers", space.id);

            const data = {
                user: toPublicUser(user),
                ...member,
            };

            await emitEvent({
                event: "SpaceDelete",
                user_id: user.id,
                data: space,
            });

            await emitEvent({
                event: "SpaceMemberRemove",
                space_id: space.id,
                data,
            });

            await invalidateCache("spaceHydrated", spaceId);

            res.status(HttpStatusCode.Success).json(data);
        } catch (err) {
            next(err);
        }
    }

    static async addRole(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId, roleId } = validateRoleMemberParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id)) {
                const me = await getMember(space.id, user.id);
                if (!me)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You are not a member of this space",
                    );
            }

            const { permissions: actorPermissions } =
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["ManageRoles"],
                });

            const actorIsOwner = BigInt(space.ownerId) === BigInt(user.id);
            const actorIsAdmin =
                (actorPermissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            const targetMember = await getMember(space.id, userId);
            if (!targetMember)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            if (BigInt(roleId) === BigInt(space.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "Cannot assign @everyone role",
                );

            const role = await db.query.rolesTable.findFirst({
                where: and(
                    eq(rolesTable.id, BigInt(roleId)),
                    eq(rolesTable.spaceId, BigInt(space.id)),
                ),
            });

            if (!role)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Role not found",
                );

            if (!actorIsOwner && !actorIsAdmin) {
                const [actorRoles, targetRoles] = await Promise.all([
                    getMemberRoles(space.id, user.id),
                    getMemberRoles(space.id, userId),
                ]);

                const actorTop = topPos(actorRoles);
                const targetTop = topPos(targetRoles);

                if (actorTop <= targetTop)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents modifying this member",
                    );

                if (actorTop <= role.position)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents assigning this role",
                    );
            }

            await db
                .insert(spaceMemberRolesTable)
                .values({
                    spaceId: BigInt(space.id),
                    userId: BigInt(userId),
                    roleId: BigInt(role.id),
                })
                .onConflictDoNothing();

            await Promise.all([
                invalidateCache("spaceHydrated", space.id),
                invalidateCache("spaceMember", `${space.id}:${userId}`),
                invalidateCache("spaceMembers", space.id),
            ]);

            await emitEvent({
                event: "SpaceMemberRoleAdd",
                space_id: space.id,
                data: {
                    spaceId,
                    userId,
                    roleId: role.id,
                },
            });

            res.status(HttpStatusCode.Success).json(role);
        } catch (err) {
            next(err);
        }
    }

    static async removeRole(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId, roleId } = validateRoleMemberParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id)) {
                const me = await getMember(space.id, user.id);
                if (!me)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You are not a member of this space",
                    );
            }

            const { permissions: actorPermissions } =
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["ManageRoles"],
                });

            const actorIsOwner = BigInt(space.ownerId) === BigInt(user.id);
            const actorIsAdmin =
                (actorPermissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            const targetMember = await getMember(space.id, userId);
            if (!targetMember)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            if (BigInt(roleId) === BigInt(space.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "Cannot remove @everyone role",
                );

            const role = await db.query.rolesTable.findFirst({
                where: and(
                    eq(rolesTable.id, BigInt(roleId)),
                    eq(rolesTable.spaceId, BigInt(space.id)),
                ),
            });
            if (!role)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Role not found",
                );

            if (!actorIsOwner && !actorIsAdmin) {
                const [actorRoles, targetRoles] = await Promise.all([
                    getMemberRoles(space.id, user.id),
                    getMemberRoles(space.id, userId),
                ]);

                const actorTop = topPos(actorRoles);
                const targetTop = topPos(targetRoles);

                if (actorTop <= targetTop) {
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents modifying this member",
                    );
                }

                if (actorTop <= role.position) {
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents removing this role",
                    );
                }
            }

            await db
                .delete(spaceMemberRolesTable)
                .where(
                    and(
                        eq(spaceMemberRolesTable.spaceId, BigInt(space.id)),
                        eq(spaceMemberRolesTable.userId, BigInt(userId)),
                        eq(spaceMemberRolesTable.roleId, BigInt(role.id)),
                    ),
                )
                .execute();

            await Promise.all([
                invalidateCache("spaceHydrated", String(space.id)),
                invalidateCache("spaceMember", `${space.id}:${userId}`),
                invalidateCache("spaceMembers", String(space.id)),
            ]);

            await emitEvent({
                event: "SpaceMemberRoleRemove",
                space_id: space.id,
                data: {
                    spaceId,
                    userId,
                    roleId: role.id,
                },
            });

            res.status(HttpStatusCode.NoContent).send();
        } catch (err) {
            next(err);
        }
    }

    // TODO: in the future implement the reaason parameter and create logs for moderation actions on the spaces
    static async kick(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId } = validateMembersActionParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const member = await getMember(space.id, userId || user.id);
            if (!member)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            if (BigInt(member.userId) === BigInt(space.ownerId))
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Cannot kick the space owner",
                );

            const { permissions } = await requireSpacePermissions({
                spaceId,
                userId: user.id,
                needed: ["KickMembers"],
            });

            const isAdmin =
                (permissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            if (!isAdmin) {
                const actorRoles = await getMemberRoles(space.id, user.id);
                const targetRoles = await getMemberRoles(
                    space.id,
                    member.userId,
                );

                const actorTop = topPos(actorRoles);
                const targetTop = topPos(targetRoles);

                if (actorTop <= targetTop)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents kicking this member",
                    );
            }

            await db
                .delete(spaceMembersTable)
                .where(
                    and(
                        eq(spaceMembersTable.spaceId, BigInt(space.id)),
                        eq(spaceMembersTable.userId, BigInt(member.userId)),
                    ),
                )
                .execute();

            await deleteCache("spaceMember", `${space.id}:${member.userId}`);
            await invalidateCache("spaceMembers", space.id);

            await emitEvent({
                event: "SpaceMemberRemove",
                space_id: space.id,
                data: member,
            });

            await invalidateCache("spaceHydrated", spaceId);

            res.status(HttpStatusCode.Success).json(member);
        } catch (err) {
            next(err);
        }
    }

    // TODO: Add ban database schema
    static async ban(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId } = validateMembersActionParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const member = await getMember(space.id, userId || user.id);
            if (!member)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            if (BigInt(member.userId) === BigInt(space.ownerId))
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Cannot ban the space owner",
                );

            const { permissions } = await requireSpacePermissions({
                spaceId,
                userId: user.id,
                needed: ["BanMembers"],
            });

            const isAdmin =
                (permissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            if (!isAdmin) {
                const actorRoles = await getMemberRoles(space.id, user.id);
                const targetRoles = await getMemberRoles(
                    space.id,
                    member.userId,
                );

                const actorTop = topPos(actorRoles);
                const targetTop = topPos(targetRoles);

                if (actorTop <= targetTop)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Role hierarchy prevents banning this member",
                    );
            }

            const { deleteMessageTimeframe } = validateMemberBanBody.parse(
                req.body,
            );

            await db.transaction(async (tx) => {
                await tx
                    .delete(spaceMembersTable)
                    .where(
                        and(
                            eq(spaceMembersTable.spaceId, BigInt(space.id)),
                            eq(spaceMembersTable.userId, BigInt(member.userId)),
                        ),
                    )
                    .execute();

                // 0 = do not delete messages, -1 = delete all messages, > 0 = delete messages from the last x seconds
                if (deleteMessageTimeframe === 0) return;
                if (deleteMessageTimeframe === -1) {
                    const messages = await execNormalizedMany<APIMessage>(
                        tx
                            .delete(messagesTable)
                            .where(
                                and(
                                    eq(messagesTable.spaceId, BigInt(space.id)),
                                    eq(
                                        messagesTable.authorId,
                                        BigInt(member.userId),
                                    ),
                                ),
                            )
                            .returning()
                            .execute(),
                    );

                    await emitEvent({
                        event: "MessageDeleteBulk",
                        space_id: space.id,
                        data: messages.map((m) => ({
                            id: m.id,
                            channelId: m.channelId,
                        })),
                    });
                }

                const deleteBefore = dayjs()
                    .subtract(deleteMessageTimeframe, "seconds")
                    .date();

                const messages = await execNormalizedMany<APIMessage>(
                    tx
                        .delete(messagesTable)
                        .where(
                            and(
                                eq(messagesTable.spaceId, BigInt(space.id)),
                                eq(
                                    messagesTable.authorId,
                                    BigInt(member.userId),
                                ),
                                sql`${messagesTable.createdAt} >= ${deleteBefore}`,
                            ),
                        )
                        .returning()
                        .execute(),
                );

                await emitEvent({
                    event: "MessageDeleteBulk",
                    space_id: space.id,
                    data: messages.map((m) => ({
                        id: m.id,
                        channelId: m.channelId,
                    })),
                });
            });

            await emitEvent({
                event: "SpaceMemberRemove",
                space_id: space.id,
                data: member,
            });

            await invalidateCache("spaceHydrated", spaceId);

            res.status(HttpStatusCode.Success).json(member);
        } catch (err) {
            next(err);
        }
    }

    static async patchVoiceModeration(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, userId } = validateMembersActionParams.parse(
                req.params,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const member = await getMember(space.id, userId);
            if (!member)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Member not found",
                );

            const { spaceMute, spaceDeaf } =
                validateMemberVoiceModerationBody.parse(req.body);

            if (spaceMute != null) {
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["MuteMembers"],
                });
            }

            if (spaceDeaf != null) {
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["DeafenMembers"],
                });
            }

            const memberBitfield = BitField.fromString(
                memberFlags,
                member.flags.toString(),
            );

            if (spaceMute != null) {
                if (spaceMute) memberBitfield.add("VoiceSpaceMuted");
                else memberBitfield.remove("VoiceSpaceMuted");
            }

            if (spaceDeaf != null) {
                if (spaceDeaf) memberBitfield.add("VoiceSpaceDeafened");
                else memberBitfield.remove("VoiceSpaceDeafened");
            }

            const nextFlags = memberBitfield.toBigInt();

            await db
                .update(spaceMembersTable)
                .set({ flags: nextFlags })
                .where(
                    and(
                        eq(spaceMembersTable.spaceId, BigInt(space.id)),
                        eq(spaceMembersTable.userId, BigInt(userId)),
                    ),
                );

            await deleteCache("spaceMember", `${space.id}:${userId}`);
            await invalidateCache("spaceMembers", space.id);
            await invalidateCache("spaceHydrated", spaceId);

            await VoiceStateService.applyMemberVoiceModeration(
                space.id,
                userId,
                {
                    spaceMute,
                    spaceDeaf,
                },
            );

            const updated = await getMember(space.id, userId);

            return res
                .status(HttpStatusCode.Success)
                .json(updated ?? { ...member, flags: nextFlags });
        } catch (err) {
            next(err);
        }
    }
}
