import { deleteCache, getCache, setCache } from "@mutualzz/cache";
import {
    channelsTable,
    db,
    invitesTable,
    spaceMemberRolesTable,
    spaceMembersTable,
    toPublicUser,
} from "@mutualzz/database";
import type { APIChannel, APISpaceMember } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getMember,
    getSpace,
} from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
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

            const { spaceId } = req.params;

            const space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (!(await getMember(space.id, user.id, true)))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not a member of this space",
                );

            let members = await getCache("spaceMembers", space.id);
            if (!members)
                members = await execNormalizedMany<APISpaceMember>(
                    db.query.spaceMembersTable.findMany({
                        with: {
                            user: true,
                        },
                        where: eq(spaceMembersTable.spaceId, BigInt(space.id)),
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

            const { spaceId } = req.params;

            const space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const { userId } = req.params;

            const member = await getMember(space.id, userId || user.id);

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

    static async add(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = req.params;

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
                spaceId: BigInt(space.id),
                userId: BigInt(user.id),
                assignedAt: new Date(),
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

            const { spaceId } = req.params;

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

            await db
                .delete(spaceMemberRolesTable)
                .where(
                    and(
                        eq(spaceMemberRolesTable.spaceId, BigInt(space.id)),
                        eq(spaceMemberRolesTable.userId, BigInt(member.userId)),
                    ),
                );

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
