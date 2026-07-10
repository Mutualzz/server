import { deleteCache, invalidateCache } from "@mutualzz/cache";
import {
  db,
  messagesTable,
  postCommentsTable,
  postsTable,
  reportsTable,
  spacesTable,
  staffActionsTable,
} from "@mutualzz/database";
import type {
  APIMessage,
  APIPost,
  APIPostComment,
  APIReport,
  APIReportContent,
  APIReportDetail,
  APIReportSpaceContent,
  StaffActionType,
} from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  applySpaceLockdown,
  bucketName,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForget,
  fireAndForgetAll,
  formatStaffReportActionReason,
  getFriendIds,
  publicUserColumns,
  requireStaff,
  resolveUserIdentifier,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  validateStaffReportParams,
  validateStaffReportsQuery,
  validateStaffReportTakedownBody,
  validateStaffReportUpdateBody,
} from "@mutualzz/validators";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const MESSAGE_CONTEXT_LIMIT = 3;

const reportUserColumns = {
  id: true,
  username: true,
  globalName: true,
  avatar: true,
} as const;

const messageWith = {
  author: { columns: publicUserColumns },
} as const;

async function loadReport(reportId: string) {
  const report = await execNormalized<APIReport>(
    db.query.reportsTable.findFirst({
      where: eq(reportsTable.id, BigInt(reportId)),
      with: {
        reporter: { columns: reportUserColumns },
        reviewedBy: { columns: reportUserColumns },
      },
    }),
  );

  return report;
}

async function loadReportContent(
  targetType: APIReport["targetType"],
  targetId: bigint,
): Promise<APIReportContent> {
  switch (targetType) {
    case "message": {
      const reported = await execNormalized<APIMessage>(
        db.query.messagesTable.findFirst({
          where: eq(messagesTable.id, targetId),
          with: {
            ...messageWith,
            channel: {
              columns: { id: true, type: true, spaceId: true },
            },
          },
        }),
      );

      if (!reported) {
        return {
          type: "unavailable",
          message: "This message was deleted or is no longer available",
        };
      }

      const [before, after] = await Promise.all([
        execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            where: and(
              eq(messagesTable.channelId, BigInt(reported.channelId)),
              lt(messagesTable.id, BigInt(reported.id)),
            ),
            orderBy: desc(messagesTable.id),
            limit: MESSAGE_CONTEXT_LIMIT,
            with: messageWith,
          }),
        ),
        execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            where: and(
              eq(messagesTable.channelId, BigInt(reported.channelId)),
              gt(messagesTable.id, BigInt(reported.id)),
            ),
            orderBy: asc(messagesTable.id),
            limit: MESSAGE_CONTEXT_LIMIT,
            with: messageWith,
          }),
        ),
      ]);

      const channelType = reported.channel?.type ?? ChannelType.Text;
      const isDirectMessage =
        channelType === ChannelType.DM || channelType === ChannelType.GroupDM;

      return {
        type: "message",
        data: {
          reported,
          context: [...before.reverse(), reported, ...after],
          channelType,
          isDirectMessage,
        },
      };
    }
    case "post": {
      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, targetId),
          with: { author: { columns: publicUserColumns } },
        }),
      );

      if (!post) {
        return {
          type: "unavailable",
          message: "This post was deleted or is no longer available",
        };
      }

      return { type: "post", data: { post } };
    }
    case "comment": {
      const comment = await execNormalized<APIPostComment>(
        db.query.postCommentsTable.findFirst({
          where: eq(postCommentsTable.id, targetId),
          with: { author: { columns: publicUserColumns } },
        }),
      );

      if (!comment) {
        return {
          type: "unavailable",
          message: "This comment was deleted or is no longer available",
        };
      }

      return { type: "comment", data: { comment } };
    }
    case "user": {
      const user = await resolveUserIdentifier(targetId.toString());

      if (!user) {
        return {
          type: "unavailable",
          message: "This user account is no longer available",
        };
      }

      return {
        type: "user",
        data: {
          user: {
            id: user.id,
            username: user.username,
            globalName: user.globalName,
            avatar: user.avatar,
          },
        },
      };
    }
    case "space": {
      const space = await execNormalized<APIReportSpaceContent["space"]>(
        db.query.spacesTable.findFirst({
          where: eq(spacesTable.id, targetId),
          columns: {
            id: true,
            name: true,
            description: true,
            icon: true,
            ownerId: true,
            memberCount: true,
            flags: true,
            createdAt: true,
          },
          with: {
            owner: { columns: reportUserColumns },
          },
        }),
      );

      if (!space) {
        return {
          type: "unavailable",
          message: "This space was deleted or is no longer available",
        };
      }

      return { type: "space", data: { space } };
    }
  }
}

function getAuditTargetId(content: APIReportContent): bigint | null {
  switch (content.type) {
    case "message":
      return content.data.reported.authorId
        ? BigInt(content.data.reported.authorId)
        : null;
    case "post":
      return content.data.post.authorId
        ? BigInt(content.data.post.authorId)
        : null;
    case "comment":
      return content.data.comment.authorId
        ? BigInt(content.data.comment.authorId)
        : null;
    case "user":
      return BigInt(content.data.user.id);
    case "space":
      return BigInt(content.data.space.ownerId);
    case "unavailable":
      return null;
  }
}

async function logReportView(
  actorId: string,
  reportId: string,
  content: APIReportContent,
) {
  await db.insert(staffActionsTable).values({
    id: BigInt(Snowflake.generate()),
    actorId: BigInt(actorId),
    targetId: getAuditTargetId(content),
    action: "report.view" satisfies StaffActionType,
    reason: `Report ${reportId}`,
  });
}

async function deleteReportedSpace(
  space: { id: bigint; icon: string | null },
  actorId: string,
  reason: string,
) {
  await db.delete(spacesTable).where(eq(spacesTable.id, space.id)).execute();

  const spaceId = space.id.toString();

  void deleteCache("space", spaceId);
  void deleteCache("spaceMembers", spaceId);
  void invalidateCache("spaceHydrated", spaceId);

  fireAndForget(
    () =>
      emitEvent({
        event: "SpaceDelete",
        space_id: spaceId,
        data: { id: spaceId },
      }),
    { label: "event:SpaceDelete (staffReports.takedown)" },
  );

  if (space.icon) {
    const isGif = space.icon.startsWith("a_");
    const storedExt = isGif ? "gif" : "png";

    fireAndForget(
      async () => {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: `icons/spaces/${spaceId}/${space.icon}.${storedExt}`,
          }),
        );
      },
      { label: "s3:delete-space-icon (staffReports.takedown)" },
    );
  }

  await db.insert(staffActionsTable).values({
    id: BigInt(Snowflake.generate()),
    actorId: BigInt(actorId),
    targetId: null,
    action: "space.delete" satisfies StaffActionType,
    reason,
  });
}

export default class StaffReportsController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { status, targetType, before, limit } =
        validateStaffReportsQuery.parse(req.query);

      const conditions = [];
      if (status) conditions.push(eq(reportsTable.status, status));
      if (targetType) conditions.push(eq(reportsTable.targetType, targetType));
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

  static async getDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);
      const { reportId } = validateStaffReportParams.parse(req.params);

      const report = await loadReport(reportId);

      if (!report)
        throw new HttpException(HttpStatusCode.NotFound, "Report not found");

      const content = await loadReportContent(
        report.targetType,
        BigInt(report.targetId),
      );

      await logReportView(actor.id, reportId, content);

      const detail: APIReportDetail = {
        ...report,
        content,
      };

      res.status(HttpStatusCode.Success).json(detail);
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
        throw new HttpException(HttpStatusCode.NotFound, "Report not found");

      const report = await loadReport(reportId);

      res.status(HttpStatusCode.Success).json(report);
    } catch (err) {
      next(err);
    }
  }

  static async lockdown(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { reportId } = validateStaffReportParams.parse(req.params);
      const { reason } = validateStaffReportTakedownBody.parse(req.body);

      const report = await db.query.reportsTable.findFirst({
        where: eq(reportsTable.id, BigInt(reportId)),
      });

      if (!report)
        throw new HttpException(HttpStatusCode.NotFound, "Report not found");

      if (report.targetType !== "space")
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Only space reports can be locked down",
        );

      const takedownReason = formatStaffReportActionReason(report, reason);

      await applySpaceLockdown(
        report.targetId.toString(),
        actor.id,
        takedownReason,
      );

      await db
        .update(reportsTable)
        .set({
          status: "actioned",
          reviewedById: BigInt(actor.id),
          reviewedAt: new Date(),
        })
        .where(eq(reportsTable.id, BigInt(reportId)));

      const updated = await loadReport(reportId);

      res.status(HttpStatusCode.Success).json({
        report: updated,
        contentRemoved: false,
      });
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
        throw new HttpException(HttpStatusCode.NotFound, "Report not found");

      if (report.targetType === "user")
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "User accounts can't be taken down this way, use the disable action instead",
        );

      let contentAuthorId: bigint | null = null;
      let contentRemoved = false;
      const takedownReason = formatStaffReportActionReason(report, reason);

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
              run: () => deleteCache("message", message.id.toString()),
            },
            {
              label: "cache:invalidate:messages",
              run: () =>
                invalidateCache("messages", message.channelId.toString()),
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

          await db.delete(postsTable).where(eq(postsTable.id, post.id));

          fireAndForgetAll([
            {
              label: "event:PostDelete",
              run: async () => {
                const notifyIds = [
                  post.authorId.toString(),
                  ...(await getFriendIds(post.authorId.toString())),
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
              run: () => invalidateCache("posts", post.authorId.toString()),
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
              [comment.authorId.toString(), post?.authorId.toString()].filter(
                (id): id is string => !!id,
              ),
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
                invalidateCache("postComments", comment.postId.toString()),
            },
          ]);
        }
      } else if (report.targetType === "space") {
        const space = await db.query.spacesTable.findFirst({
          where: eq(spacesTable.id, BigInt(report.targetId)),
          columns: { id: true, icon: true, ownerId: true },
        });

        if (space) {
          contentAuthorId = space.ownerId;
          contentRemoved = true;

          await deleteReportedSpace(space, actor.id, takedownReason);
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

      if (contentAuthorId && report.targetType !== "space") {
        await db.insert(staffActionsTable).values({
          id: BigInt(Snowflake.generate()),
          actorId: BigInt(actor.id),
          targetId: contentAuthorId,
          action:
            `content.takedown.${report.targetType}` satisfies StaffActionType,
          reason: takedownReason,
        });
      }

      const updated = await loadReport(reportId);

      res.status(HttpStatusCode.Success).json({
        report: updated,
        contentRemoved,
      });
    } catch (err) {
      next(err);
    }
  }
}
