import { deleteCache, invalidateCache } from "@mutualzz/cache";
import {
    db,
    messagesTable,
    postCommentsTable,
    postsTable,
    reportsTable,
    staffActionsTable,
} from "@mutualzz/database";
import type { APIReport, StaffActionType } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalizedMany,
    fireAndForgetAll,
    getFriendIds,
    requireStaff,
    Snowflake,
} from "@mutualzz/util";
import {
    validateStaffReportParams,
    validateStaffReportsQuery,
    validateStaffReportTakedownBody,
    validateStaffReportUpdateBody,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const reportUserColumns = {
    id: true,
    username: true,
    globalName: true,
    avatar: true,
} as const;

export default class StaffReportsController {
    static async list(req: Request, res: Response, next: NextFunction) {
        try {
            requireStaff(req.user);

            const { status, targetType, before, limit } =
                validateStaffReportsQuery.parse(req.query);

            const conditions = [];
            if (status) conditions.push(eq(reportsTable.status, status));
            if (targetType)
                conditions.push(eq(reportsTable.targetType, targetType));
            if (before) conditions.push(lt(reportsTable.id, BigInt(before)));

            const reports = await execNormalizedMany<APIReport>(
                db.query.reportsTable.findMany({
                    where: conditions.length ? and(...conditions) : undefined,
                    orderBy: desc(reportsTable.createdAt),
                    limit,
                    with: {
                        reporter: { columns: reportUserColumns },
                        reviewedBy: { columns: reportUserColumns },
                    },
                }),
            );

            res.status(HttpStatusCode.Success).json(reports);
        } catch (err) {
            next(err);
        }
    }

    static async updateStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);

            const { reportId } = validateStaffReportParams.parse(req.params);
            const { status } = validateStaffReportUpdateBody.parse(req.body);

            const updated = await db
                .update(reportsTable)
                .set({
                    status,
                    reviewedById: BigInt(actor.id),
                    reviewedAt: new Date(),
                })
                .where(eq(reportsTable.id, BigInt(reportId)))
                .returning()
                .then((rows) => (rows.length ? rows[0] : null));

            if (!updated)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Report not found",
                );

            const [report] = await execNormalizedMany<APIReport>(
                db.query.reportsTable.findMany({
                    where: eq(reportsTable.id, BigInt(reportId)),
                    limit: 1,
                    with: {
                        reporter: { columns: reportUserColumns },
                        reviewedBy: { columns: reportUserColumns },
                    },
                }),
            );

            res.status(HttpStatusCode.Success).json(report);
        } catch (err) {
            next(err);
        }
    }

    static async takedown(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);

            const { reportId } = validateStaffReportParams.parse(req.params);
            const { reason } = validateStaffReportTakedownBody.parse(req.body);

            const report = await db.query.reportsTable.findFirst({
                where: eq(reportsTable.id, BigInt(reportId)),
            });

            if (!report)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Report not found",
                );

            if (report.targetType === "user")
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "User accounts can't be taken down this way, use the disable action instead",
                );

            let contentAuthorId: bigint | null = null;
            let contentRemoved = false;

            if (report.targetType === "message") {
                const message = await db.query.messagesTable.findFirst({
                    where: eq(messagesTable.id, BigInt(report.targetId)),
                });

                if (message) {
                    contentAuthorId = message.authorId;
                    contentRemoved = true;

                    await db
                        .delete(messagesTable)
                        .where(eq(messagesTable.id, message.id));

                    fireAndForgetAll([
                        {
                            label: "event:MessageDelete",
                            run: () =>
                                emitEvent({
                                    event: "MessageDelete",
                                    channel_id: message.channelId.toString(),
                                    data: {
                                        id: message.id,
                                        channelId: message.channelId,
                                    },
                                }),
                        },
                        {
                            label: "cache:delete:message",
                            run: () =>
                                deleteCache("message", message.id.toString()),
                        },
                        {
                            label: "cache:invalidate:messages",
                            run: () =>
                                invalidateCache(
                                    "messages",
                                    message.channelId.toString(),
                                ),
                        },
                    ]);
                }
            } else if (report.targetType === "post") {
                const post = await db.query.postsTable.findFirst({
                    where: eq(postsTable.id, BigInt(report.targetId)),
                });

                if (post) {
                    contentAuthorId = post.authorId;
                    contentRemoved = true;

                    await db
                        .delete(postsTable)
                        .where(eq(postsTable.id, post.id));

                    fireAndForgetAll([
                        {
                            label: "event:PostDelete",
                            run: async () => {
                                const notifyIds = [
                                    post.authorId.toString(),
                                    ...(await getFriendIds(
                                        post.authorId.toString(),
                                    )),
                                ];

                                await Promise.all(
                                    notifyIds.map((id) =>
                                        emitEvent({
                                            event: "PostDelete",
                                            user_id: id,
                                            data: { id: post.id },
                                        }),
                                    ),
                                );
                            },
                        },
                        {
                            label: "cache:delete:post",
                            run: () => deleteCache("post", post.id.toString()),
                        },
                        {
                            label: "cache:invalidate:posts",
                            run: () =>
                                invalidateCache(
                                    "posts",
                                    post.authorId.toString(),
                                ),
                        },
                    ]);
                }
            } else if (report.targetType === "comment") {
                const comment = await db.query.postCommentsTable.findFirst({
                    where: eq(postCommentsTable.id, BigInt(report.targetId)),
                });

                if (comment) {
                    contentAuthorId = comment.authorId;
                    contentRemoved = true;

                    await db
                        .delete(postCommentsTable)
                        .where(eq(postCommentsTable.id, comment.id));

                    const post = await db.query.postsTable.findFirst({
                        where: eq(postsTable.id, comment.postId),
                    });

                    const notifyIds = Array.from(
                        new Set(
                            [
                                comment.authorId.toString(),
                                post?.authorId.toString(),
                            ].filter((id): id is string => !!id),
                        ),
                    );

                    fireAndForgetAll([
                        {
                            label: "event:PostCommentDelete",
                            run: () =>
                                Promise.all(
                                    notifyIds.map((id) =>
                                        emitEvent({
                                            event: "PostCommentDelete",
                                            user_id: id,
                                            data: {
                                                id: comment.id,
                                                postId: comment.postId,
                                            },
                                        }),
                                    ),
                                ),
                        },
                        {
                            label: "cache:invalidate:postComments",
                            run: () =>
                                invalidateCache(
                                    "postComments",
                                    comment.postId.toString(),
                                ),
                        },
                    ]);
                }
            }

            await db
                .update(reportsTable)
                .set({
                    status: "actioned",
                    reviewedById: BigInt(actor.id),
                    reviewedAt: new Date(),
                })
                .where(eq(reportsTable.id, BigInt(reportId)));

            if (contentAuthorId) {
                await db.insert(staffActionsTable).values({
                    id: BigInt(Snowflake.generate()),
                    actorId: BigInt(actor.id),
                    targetId: contentAuthorId,
                    action:
                        `content.takedown.${report.targetType}` satisfies StaffActionType,
                    reason: reason ?? `Removed via report ${reportId}`,
                });
            }

            const [updated] = await execNormalizedMany<APIReport>(
                db.query.reportsTable.findMany({
                    where: eq(reportsTable.id, BigInt(reportId)),
                    limit: 1,
                    with: {
                        reporter: { columns: reportUserColumns },
                        reviewedBy: { columns: reportUserColumns },
                    },
                }),
            );

            res.status(HttpStatusCode.Success).json({
                report: updated,
                contentRemoved,
            });
        } catch (err) {
            next(err);
        }
    }
}
