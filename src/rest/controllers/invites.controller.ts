import {
    cacheKeyPrefix,
    deleteCache,
    getCache,
    setCache,
} from "@mutualzz/cache";
import { db, invitesTable, spaceMembersTable } from "@mutualzz/database";
import type { APIInvite } from "@mutualzz/types";
import { HttpException, HttpStatusCode, InviteType } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    generateInviteCode,
    getSpace,
    getUser,
} from "@mutualzz/util";
import {
    validateInviteBodyPost,
    validateInviteParamsGet,
} from "@mutualzz/validators";
import dayjs from "dayjs";
import { and, count, eq, gte } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class InvitesController {
    static async get(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateInviteParamsGet.parse(req.params);

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You don't have permission to view invites for this space",
                );

            let invites = await getCache("invites", spaceId);
            if (invites)
                return res.status(HttpStatusCode.Success).json(invites);

            invites = await execNormalizedMany<APIInvite>(
                db.query.invitesTable.findMany({
                    with: {
                        inviter: true,
                    },
                    where: eq(invitesTable.spaceId, BigInt(spaceId)),
                }),
            );

            await setCache("invites", spaceId, invites);

            return res.status(HttpStatusCode.Success).json(invites);
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

            const { spaceId, code } = req.params;

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You don't have permission to view invites for this space",
                );

            const cacheKey = cacheKeyPrefix("invite", code);
            let invite = await getCache("invite", cacheKey);
            if (invite) return res.status(HttpStatusCode.Success).json(invite);

            invite = await execNormalized<APIInvite>(
                db.query.invitesTable.findFirst({
                    where: and(
                        eq(invitesTable.code, code),
                        eq(invitesTable.spaceId, BigInt(spaceId)),
                    ),
                }),
            );

            if (!invite)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Invite not found",
                );

            await setCache("invite", cacheKey, invite);

            return res.status(HttpStatusCode.Success).json(invite);
        } catch (err) {
            next(err);
        }
    }

    static async getFromCode(req: Request, res: Response, next: NextFunction) {
        try {
            const { code } = req.params;

            const invite = await execNormalized<APIInvite>(
                db.query.invitesTable.findFirst({
                    with: {
                        space: {
                            with: {
                                members: {
                                    where: eq(
                                        spaceMembersTable.userId,
                                        BigInt(req.user?.id ?? 0),
                                    ),
                                },
                            },
                        },
                        inviter: true,
                    },
                    where: eq(invitesTable.code, code),
                }),
            );

            if (!invite)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Invite not found",
                );

            return res.status(HttpStatusCode.Success).json(invite);
        } catch (err) {
            next(err);
        }
    }

    static async create(req: Request, res: Response, next: NextFunction) {
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

            const { channelId } = validateInviteBodyPost.parse(req.body);

            const reuseWindowSecs = 60;

            const recentInvite = await execNormalized<APIInvite>(
                db.query.invitesTable.findFirst({
                    where: and(
                        eq(invitesTable.channelId, BigInt(channelId)),
                        eq(invitesTable.spaceId, BigInt(spaceId)),
                        gte(
                            invitesTable.createdAt,
                            dayjs()
                                .subtract(reuseWindowSecs, "seconds")
                                .toDate(),
                        ),
                    ),
                }),
            );

            if (recentInvite)
                return res.status(HttpStatusCode.Success).json(recentInvite);

            const totalInvites = await db
                .select({
                    count: count(invitesTable.code),
                })
                .from(invitesTable)
                .where(eq(invitesTable.spaceId, BigInt(spaceId)))
                .then((r) => r[0].count);

            if (totalInvites > 20) {
                const oldestInvite = await execNormalized<APIInvite>(
                    db.query.invitesTable.findFirst({
                        where: eq(invitesTable.spaceId, BigInt(spaceId)),
                        orderBy: invitesTable.createdAt,
                    }),
                );

                if (oldestInvite)
                    return res
                        .status(HttpStatusCode.Success)
                        .json(oldestInvite);
            }

            const code = generateInviteCode();

            const newInvite = await execNormalized<APIInvite>(
                db
                    .insert(invitesTable)
                    .values({
                        code,
                        type: InviteType.Space,
                        spaceId: BigInt(spaceId),
                        inviterId: BigInt(user.id),
                        channelId: BigInt(channelId),
                        expiresAt: dayjs().add(7, "days").toDate(),
                    })
                    .returning()
                    .then((results) => results[0])
                    .then(async (invite) => {
                        return {
                            ...invite,
                            inviter: await getUser(
                                invite.inviterId?.toString(),
                            ),
                        };
                    }),
            );

            if (!newInvite)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create invite",
                );

            await deleteCache("invites", spaceId);
            await setCache("invite", code, newInvite);

            await emitEvent({
                event: "InviteCreate",
                space_id: space.id,
                channel_id: channelId,
                data: newInvite,
            });

            return res.status(HttpStatusCode.Created).json(newInvite);
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, code } = req.params;

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            let invite = await getCache("invite", code);
            if (!invite)
                invite = await execNormalized<APIInvite>(
                    db.query.invitesTable.findFirst({
                        where: and(
                            eq(invitesTable.code, code),
                            eq(invitesTable.spaceId, BigInt(spaceId)),
                        ),
                    }),
                );

            if (!invite)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Invite not found",
                );

            const { maxUses, expiresAt } = req.body;

            const neverExpires = expiresAt === null;

            invite = await execNormalized<APIInvite>(
                db
                    .update(invitesTable)
                    .set({
                        maxUses: maxUses ?? invite.maxUses,
                        expiresAt: neverExpires
                            ? null
                            : dayjs().add(expiresAt, "seconds").toDate(),
                    })
                    .where(
                        and(
                            eq(invitesTable.code, code),
                            eq(invitesTable.spaceId, BigInt(spaceId)),
                        ),
                    )
                    .returning()
                    .then((results) => results[0]),
            );

            if (!invite)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update invite",
                );

            if (invite.uses > invite.maxUses && invite.maxUses !== 0) {
                await db
                    .delete(invitesTable)
                    .where(
                        and(
                            eq(invitesTable.code, code),
                            eq(invitesTable.spaceId, BigInt(spaceId)),
                        ),
                    );

                await deleteCache("invite", code);
                await deleteCache("invites", spaceId);

                await emitEvent({
                    event: "InviteDelete",
                    space_id: space.id,
                    channel_id: invite.channelId,
                    data: invite,
                });

                res.status(HttpStatusCode.Success).json(invite);

                return;
            }

            await deleteCache("invites", spaceId);
            await setCache("invite", code, invite);

            await emitEvent({
                event: "InviteUpdate",
                space_id: space.id,
                channel_id: invite.channelId,
                data: invite,
            });

            return res.status(HttpStatusCode.Success).json(invite);
        } catch (err) {
            next(err);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, code } = req.params;

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You don't have permission to delete invites for this space",
                );

            let invite = await getCache("invite", code);
            if (!invite)
                invite = await execNormalized<APIInvite>(
                    db.query.invitesTable.findFirst({
                        where: and(
                            eq(invitesTable.code, code),
                            eq(invitesTable.spaceId, BigInt(spaceId)),
                        ),
                    }),
                );

            if (!invite)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Invite not found",
                );

            await db
                .delete(invitesTable)
                .where(
                    and(
                        eq(invitesTable.code, code),
                        eq(invitesTable.spaceId, BigInt(spaceId)),
                    ),
                );

            await deleteCache("invites", spaceId);
            await deleteCache("invite", code);

            await emitEvent({
                event: "InviteDelete",
                space_id: space.id,
                data: invite,
            });

            return res.status(HttpStatusCode.Success).json(invite);
        } catch (err) {
            next(err);
        }
    }

    static async deleteAll(req: Request, res: Response, next: NextFunction) {
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

            if (BigInt(space.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You don't have permission to delete invites for this space",
                );

            await db
                .delete(invitesTable)
                .where(eq(invitesTable.spaceId, BigInt(spaceId)));

            await deleteCache("invites", spaceId);

            res.status(HttpStatusCode.NoContent).send();
        } catch (err) {
            next(err);
        }
    }
}
