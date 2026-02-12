import { deleteCache, getCache, setCache } from "@mutualzz/cache";
import {
    channelsTable,
    db,
    invitesTable,
    spaceMemberRolesTable,
    spaceMembersTable,
    toPublicUser,
    userSettingsTable,
} from "@mutualzz/database";
import type {
    APIChannel,
    APISpaceMember,
    APIUserSettings,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getMember,
    getSpace,
    requireSpacePermissions,
} from "@mutualzz/util";
import {
    validateMembersAddParams,
    validateMembersGetAllParams,
    validateMembersGetAllQuery,
    validateMembersGetOneParams,
    validateMembersRemoveMeParams,
} from "@mutualzz/validators";
import { and, eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

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

            const space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            await requireSpacePermissions({
                spaceId: space.id,
                userId: user.id,
                needed: ["ViewChannel"],
            });

            let members = await getCache("spaceMembers", space.id);
            if (!members)
                members = await execNormalizedMany<APISpaceMember>(
                    db.query.spaceMembersTable.findMany({
                        with: {
                            user: true,
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

            const { spaceId, memberId } = validateMembersGetOneParams.parse(
                req.params,
            );

            const space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            await requireSpacePermissions({
                spaceId: space.id,
                userId: user.id,
                needed: ["ViewChannel"],
            });

            const member = await getMember(space.id, memberId || user.id);

            if (!member)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not a member of this space",
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

            const space = await getSpace(spaceId);

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
                id: BigInt(space.id),
                userId: BigInt(user.id),
                spaceId: BigInt(space.id),
            });

            let members = await getCache("spaceMembers", space.id);
            let channels = await getCache("channels", space.id);
            if (!channels)
                channels = await execNormalizedMany<APIChannel>(
                    db.query.channelsTable.findMany({
                        where: eq(channelsTable.spaceId, BigInt(space.id)),
                    }),
                );

            if (!members)
                members = await execNormalizedMany<APISpaceMember>(
                    db.query.spaceMembersTable.findMany({
                        with: {
                            user: true,
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

            const space = await getSpace(spaceId);

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
                .where(eq(spaceMembersTable.userId, BigInt(member.userId)));

            await deleteCache("spaceMember", `${space.id}:${member.userId}`);

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
                data: data,
            });

            res.status(HttpStatusCode.Success).json(data);
        } catch (err) {
            next(err);
        }
    }
}
