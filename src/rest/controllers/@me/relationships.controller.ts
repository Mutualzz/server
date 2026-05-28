import {
    type APIRelationship,
    HttpException,
    HttpStatusCode,
    RelationshipType,
    type Snowflake as SnowflakeType,
} from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    fireAndForgetAll,
    getUser,
    Snowflake,
} from "@mutualzz/util";
import { db, relationshipsTable } from "@mutualzz/database";
import { and, eq, or } from "drizzle-orm";
import { validateRelationshipRequest } from "@mutualzz/validators";
import { perspectiveForUser } from "@mutualzz/rest/util";

function normalizePair(userIdA: SnowflakeType, userIdB: SnowflakeType) {
    return BigInt(userIdA) < BigInt(userIdB)
        ? {
              userId: userIdA,
              otherUserId: userIdB,
          }
        : {
              userId: userIdB,
              otherUserId: userIdA,
          };
}

export default class RelationshipsController {
    static async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const relationships = await execNormalizedMany<APIRelationship>(
                db.query.relationshipsTable.findMany({
                    where: or(
                        eq(relationshipsTable.userId, BigInt(user.id)),
                        eq(relationshipsTable.otherUserId, BigInt(user.id)),
                    ),
                }),
            );

            res.status(HttpStatusCode.Success).json(relationships);
        } catch (err) {
            next(err);
        }
    }

    static async getIncoming(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const relationships = await execNormalizedMany<APIRelationship>(
                db.query.relationshipsTable.findMany({
                    where: or(
                        and(
                            eq(relationshipsTable.otherUserId, BigInt(user.id)),
                            eq(
                                relationshipsTable.type,
                                RelationshipType.OutgoingRequest,
                            ),
                        ),
                        and(
                            eq(relationshipsTable.userId, BigInt(user.id)),
                            eq(
                                relationshipsTable.type,
                                RelationshipType.IncomingRequest,
                            ),
                        ),
                    ),
                }),
            );

            res.status(HttpStatusCode.Success).json(relationships);
        } catch (err) {
            next(err);
        }
    }

    static async getOutgoing(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const relationships = await execNormalizedMany<APIRelationship>(
                db.query.relationshipsTable.findMany({
                    where: or(
                        and(
                            eq(relationshipsTable.userId, BigInt(user.id)),
                            eq(
                                relationshipsTable.type,
                                RelationshipType.OutgoingRequest,
                            ),
                        ),
                        and(
                            eq(relationshipsTable.otherUserId, BigInt(user.id)),
                            eq(
                                relationshipsTable.type,
                                RelationshipType.IncomingRequest,
                            ),
                        ),
                    ),
                }),
            );

            res.status(HttpStatusCode.Success).json(relationships);
        } catch (err) {
            next(err);
        }
    }

    static async getBlocked(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const relationships = await execNormalizedMany<APIRelationship>(
                db.query.relationshipsTable.findMany({
                    where: and(
                        or(
                            eq(relationshipsTable.userId, BigInt(user.id)),
                            eq(relationshipsTable.otherUserId, BigInt(user.id)),
                        ),
                        eq(relationshipsTable.type, RelationshipType.Blocked),
                    ),
                }),
            );

            res.status(HttpStatusCode.Success).json(relationships);
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

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.body,
            );

            if (targetUserId === user.id)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "You cannot add yourself",
                );

            const targetUser = await getUser(targetUserId);
            if (!targetUser)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            const pair = normalizePair(user.id, targetUserId);

            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (existing) {
                if (existing.type === RelationshipType.Blocked) {
                    if (existing.otherUserId.toString() === user.id.toString())
                        throw new HttpException(
                            HttpStatusCode.Forbidden,
                            "You cannot send a friend request to this user",
                        );

                    const relationship = await execNormalized<APIRelationship>(
                        Promise.resolve(existing),
                    );
                    return res
                        .status(HttpStatusCode.Success)
                        .json(relationship);
                }

                if (existing.type === RelationshipType.Friend) {
                    const relationship = await execNormalized<APIRelationship>(
                        Promise.resolve(existing),
                    );

                    return res
                        .status(HttpStatusCode.Success)
                        .json(relationship);
                }

                if (
                    existing.type === RelationshipType.OutgoingRequest ||
                    existing.type === RelationshipType.IncomingRequest
                ) {
                    const updated = await execNormalized<APIRelationship>(
                        db
                            .update(relationshipsTable)
                            .set({
                                type: RelationshipType.Friend,
                                updatedAt: new Date(),
                            })
                            .where(
                                and(
                                    eq(
                                        relationshipsTable.userId,
                                        BigInt(existing.userId),
                                    ),
                                    eq(
                                        relationshipsTable.otherUserId,
                                        BigInt(existing.otherUserId),
                                    ),
                                ),
                            )
                            .returning()
                            .then((rows) => rows[0]),
                    );

                    if (!updated)
                        throw new HttpException(
                            HttpStatusCode.InternalServerError,
                            "Failed to accept relationship",
                        );

                    res.status(HttpStatusCode.Success).json(updated);

                    fireAndForgetAll([
                        {
                            label: "event:RelationshipUpdate",
                            run: () =>
                                emitEvent({
                                    event: "RelationshipUpdate",
                                    user_id: user.id,
                                    data: perspectiveForUser(updated, user.id),
                                }),
                        },
                        {
                            label: "event:RelationshipUpdate",
                            run: () =>
                                emitEvent({
                                    event: "RelationshipUpdate",
                                    user_id: targetUserId,
                                    data: perspectiveForUser(
                                        updated,
                                        targetUserId,
                                    ),
                                }),
                        },
                    ]);

                    return;
                }
            }

            const created = await execNormalized<APIRelationship>(
                db
                    .insert(relationshipsTable)
                    .values({
                        id: BigInt(Snowflake.generate()),
                        userId: BigInt(pair.userId),
                        otherUserId: BigInt(pair.otherUserId),
                        type:
                            user.id.toString() === pair.userId.toString()
                                ? RelationshipType.OutgoingRequest
                                : RelationshipType.IncomingRequest,
                    })
                    .returning()
                    .then((rows) => rows[0]),
            );

            if (!created)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create relationship",
                );

            res.status(HttpStatusCode.Created).json(created);

            fireAndForgetAll([
                {
                    label: "event:RelationshipCreate:self",
                    run: () =>
                        emitEvent({
                            event: "RelationshipCreate",
                            user_id: user.id,
                            data: perspectiveForUser(created, user.id),
                        }),
                },
                {
                    label: "event:RelationshipCreate:other",
                    run: () =>
                        emitEvent({
                            event: "RelationshipCreate",
                            user_id: targetUserId,
                            data: perspectiveForUser(created, targetUserId),
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async accept(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.params,
            );

            const pair = normalizePair(user.id, targetUserId);

            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (!existing)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Relationship not found",
                );

            if (existing.type === RelationshipType.Blocked)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot accept a friend request from this user",
                );

            const updated = await execNormalized<APIRelationship>(
                db
                    .update(relationshipsTable)
                    .set({
                        type: RelationshipType.Friend,
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(
                                relationshipsTable.userId,
                                BigInt(existing.userId),
                            ),
                            eq(
                                relationshipsTable.otherUserId,
                                BigInt(existing.otherUserId),
                            ),
                        ),
                    )
                    .returning()
                    .then((rows) => rows[0]),
            );

            if (!updated)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to accept relationship",
                );

            res.status(HttpStatusCode.Success).json(updated);

            fireAndForgetAll([
                {
                    label: "event:RelationshipUpdate:self",
                    run: () =>
                        emitEvent({
                            event: "RelationshipUpdate",
                            user_id: user.id,
                            data: perspectiveForUser(updated, user.id),
                        }),
                },
                {
                    label: "event:RelationshipUpdate:other",
                    run: () =>
                        emitEvent({
                            event: "RelationshipUpdate",
                            user_id: targetUserId,
                            data: perspectiveForUser(updated, targetUserId),
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async decline(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.params,
            );

            const pair = normalizePair(user.id, targetUserId);

            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (!existing)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Relationship not found",
                );

            await db
                .delete(relationshipsTable)
                .where(
                    and(
                        eq(relationshipsTable.userId, BigInt(existing.userId)),
                        eq(
                            relationshipsTable.otherUserId,
                            BigInt(existing.otherUserId),
                        ),
                    ),
                );

            res.status(HttpStatusCode.Success).json({ success: true });

            fireAndForgetAll([
                {
                    label: "event:RelationshipDelete:self",
                    run: () =>
                        emitEvent({
                            event: "RelationshipDelete",
                            user_id: user.id,
                            data: {
                                userId: existing.userId.toString(),
                                otherUserId: existing.otherUserId.toString(),
                            },
                        }),
                },
                {
                    label: "event:RelationshipDelete:other",
                    run: () =>
                        emitEvent({
                            event: "RelationshipDelete",
                            user_id: targetUserId,
                            data: {
                                userId: existing.userId.toString(),
                                otherUserId: existing.otherUserId.toString(),
                            },
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async remove(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.params,
            );

            const pair = normalizePair(user.id, targetUserId);

            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (!existing)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Relationship not found",
                );

            await db
                .delete(relationshipsTable)
                .where(
                    and(
                        eq(relationshipsTable.userId, BigInt(existing.userId)),
                        eq(
                            relationshipsTable.otherUserId,
                            BigInt(existing.otherUserId),
                        ),
                    ),
                );

            res.status(HttpStatusCode.Success).json({ success: true });

            fireAndForgetAll([
                {
                    label: "event:RelationshipDelete:self",
                    run: () =>
                        emitEvent({
                            event: "RelationshipDelete",
                            user_id: user.id,
                            data: {
                                userId: existing.userId.toString(),
                                otherUserId: existing.otherUserId.toString(),
                            },
                        }),
                },
                {
                    label: "event:RelationshipDelete:other",
                    run: () =>
                        emitEvent({
                            event: "RelationshipDelete",
                            user_id: targetUserId,
                            data: {
                                userId: existing.userId.toString(),
                                otherUserId: existing.otherUserId.toString(),
                            },
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async block(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.params,
            );

            if (targetUserId === user.id)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "You cannot block yourself",
                );

            const pair = normalizePair(user.id, targetUserId);

            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (existing) {
                const updated = await execNormalized<APIRelationship>(
                    db
                        .update(relationshipsTable)
                        .set({
                            type: RelationshipType.Blocked,
                            updatedAt: new Date(),
                        })
                        .where(
                            and(
                                eq(
                                    relationshipsTable.userId,
                                    BigInt(existing.userId),
                                ),
                                eq(
                                    relationshipsTable.otherUserId,
                                    BigInt(existing.otherUserId),
                                ),
                            ),
                        )
                        .returning()
                        .then((rows) => rows[0]),
                );

                if (!updated)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to block user",
                    );

                res.status(HttpStatusCode.Success).json(updated);

                fireAndForgetAll([
                    {
                        label: "event:RelationshipUpdate:blocker",
                        run: () =>
                            emitEvent({
                                event: "RelationshipUpdate",
                                user_id: user.id,
                                data: perspectiveForUser(updated, user.id),
                            }),
                    },
                ]);
                return;
            }

            const created = await execNormalized<APIRelationship>(
                db
                    .insert(relationshipsTable)
                    .values({
                        id: BigInt(Snowflake.generate()),
                        userId: BigInt(pair.userId),
                        otherUserId: BigInt(pair.otherUserId),
                        type: RelationshipType.Blocked,
                    })
                    .returning()
                    .then((rows) => rows[0]),
            );

            if (!created)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to block user",
                );

            res.status(HttpStatusCode.Created).json(created);

            fireAndForgetAll([
                {
                    label: "event:RelationshipCreate:blocker",
                    run: () =>
                        emitEvent({
                            event: "RelationshipCreate",
                            user_id: user.id,
                            data: perspectiveForUser(created, user.id),
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async unblock(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { userId: targetUserId } = validateRelationshipRequest.parse(
                req.params,
            );

            const pair = normalizePair(user.id, targetUserId);

            // First, fetch the existing relationship to check who the blocker is
            const existing = await db.query.relationshipsTable.findFirst({
                where: and(
                    eq(relationshipsTable.userId, BigInt(pair.userId)),
                    eq(
                        relationshipsTable.otherUserId,
                        BigInt(pair.otherUserId),
                    ),
                ),
            });

            if (
                existing &&
                existing.type === RelationshipType.Blocked &&
                existing.otherUserId.toString() === user.id.toString()
            )
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot unblock this user because they blocked you",
                );

            await db
                .delete(relationshipsTable)
                .where(
                    and(
                        eq(relationshipsTable.userId, BigInt(pair.userId)),
                        eq(
                            relationshipsTable.otherUserId,
                            BigInt(pair.otherUserId),
                        ),
                    ),
                );

            res.status(HttpStatusCode.Success).json({ success: true });

            fireAndForgetAll([
                {
                    label: "event:RelationshipDelete:blocker",
                    run: () =>
                        emitEvent({
                            event: "RelationshipDelete",
                            user_id: user.id,
                            data: {
                                userId: pair.userId,
                                otherUserId: pair.otherUserId,
                            },
                        }),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }
}
