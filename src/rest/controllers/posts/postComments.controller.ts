import { invalidateCache } from "@mutualzz/cache";
import { db, postCommentsTable, postsTable } from "@mutualzz/database";
import {
  type APIPost,
  type APIPostComment,
  HttpException,
  HttpStatusCode,
} from "@mutualzz/types";
import {
  buildEmbeds,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  publicUserColumns,
  requireNotRestricted,
  resolveExpressions,
  sanitizeContent,
  Snowflake,
} from "@mutualzz/util";
import {
  validatePostCommentBodyPatch,
  validatePostCommentBodyPut,
  validatePostCommentParams,
  validatePostParams,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class PostCommentsController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      requireNotRestricted(user);

      const { postId } = validatePostParams.parse(req.params);

      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, BigInt(postId)),
        }),
      );

      if (!post)
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      const {
        content,
        expressionIds = [],
        repliedToId,
      } = validatePostCommentBodyPut.parse(req.body);

      if (!content && expressionIds.length === 0)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Comment must have content or stickers",
        );

      let resolvedRepliedToId: bigint | undefined;
      if (repliedToId) {
        const repliedToComment = await execNormalized<APIPostComment>(
          db.query.postCommentsTable.findFirst({
            where: eq(postCommentsTable.id, BigInt(repliedToId)),
          }),
        );

        if (
          !repliedToComment ||
          repliedToComment.postId.toString() !== postId
        )
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Comment being replied to could not be found",
          );

        // Keep replies a single level deep: replying to a reply
        // redirects to the root comment of that thread.
        resolvedRepliedToId = repliedToComment.repliedToId
          ? BigInt(repliedToComment.repliedToId)
          : BigInt(repliedToComment.id);
      }

      const sanitizedContent = content
        ? await sanitizeContent(content, null, user.id, false)
        : "";

      const embeds = await buildEmbeds(sanitizedContent);

      const commentId = BigInt(Snowflake.generate());

      const newComment = await execNormalized<APIPostComment>(
        db
          .insert(postCommentsTable)
          .values({
            id: commentId,
            postId: BigInt(postId),
            authorId: BigInt(user.id),
            content: sanitizedContent,
            embeds,
            expressionIds: [...new Set(expressionIds)].map((id) =>
              BigInt(id),
            ),
            repliedToId: resolvedRepliedToId,
          })
          .returning()
          .then((r) => (r.length > 0 ? r[0] : null)),
      );

      if (!newComment)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create comment",
        );

      const comment: APIPostComment = {
        ...newComment,
        author: user,
        expressions: await resolveExpressions(
          newComment.content,
          newComment.expressionIds,
        ),
        expressionIds: (newComment.expressionIds ?? []).map((id) =>
          id.toString(),
        ),
      };

      res.status(HttpStatusCode.Created).json(comment);

      fireAndForgetAll([
        {
          label: "event:PostCommentCreate",
          run: () => {
            const notifyIds = [user.id, post.authorId.toString()];

            return Promise.all(
              notifyIds.map((id) =>
                emitEvent({
                  event: "PostCommentCreate",
                  user_id: id,
                  data: comment,
                }),
              ),
            );
          },
        },
        {
          label: "cache:invalidate:postComments",
          run: () => invalidateCache("postComments", postId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { postId } = validatePostParams.parse(req.params);

      const beforeRaw = req.query.before ? `${req.query.before}` : undefined;
      const afterRaw = req.query.after ? `${req.query.after}` : undefined;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 50));

      if (beforeRaw && afterRaw)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot use both before and after",
        );

      let comments: APIPostComment[];

      if (beforeRaw) {
        comments = await execNormalizedMany<APIPostComment>(
          db.query.postCommentsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              eq(postCommentsTable.postId, BigInt(postId)),
              lt(postCommentsTable.id, BigInt(beforeRaw)),
            ),
            orderBy: desc(postCommentsTable.createdAt),
            limit,
          }),
        );
      } else if (afterRaw) {
        comments = await execNormalizedMany<APIPostComment>(
          db.query.postCommentsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              eq(postCommentsTable.postId, BigInt(postId)),
              gte(postCommentsTable.id, BigInt(afterRaw)),
            ),
            orderBy: asc(postCommentsTable.createdAt),
            limit,
          }),
        );
      } else {
        comments = await execNormalizedMany<APIPostComment>(
          db.query.postCommentsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: eq(postCommentsTable.postId, BigInt(postId)),
            orderBy: desc(postCommentsTable.createdAt),
            limit,
          }),
        );
      }

      const hydrated = await Promise.all(
        comments.map(async (comment) => ({
          ...comment,
          expressions: await resolveExpressions(
            comment.content,
            comment.expressionIds,
          ),
          expressionIds: (comment.expressionIds ?? []).map((id) =>
            id.toString(),
          ),
        })),
      );

      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId, commentId } = validatePostCommentParams.parse(req.params);

      const comment = await execNormalized<APIPostComment>(
        db.query.postCommentsTable.findFirst({
          with: { author: { columns: publicUserColumns } },
          where: and(
            eq(postCommentsTable.id, BigInt(commentId)),
            eq(postCommentsTable.postId, BigInt(postId)),
          ),
        }),
      );

      if (!comment)
        throw new HttpException(HttpStatusCode.NotFound, "Comment not found");

      if (BigInt(comment.authorId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You can only edit your own comments",
        );

      const { content } = validatePostCommentBodyPatch.parse(req.body);

      const sanitizedContent = await sanitizeContent(
        content,
        null,
        user.id,
        false,
      );

      const result = await execNormalized<APIPostComment>(
        db
          .update(postCommentsTable)
          .set({
            content: sanitizedContent,
            embeds: await buildEmbeds(sanitizedContent || ""),
            edited: true,
          })
          .where(eq(postCommentsTable.id, BigInt(commentId)))
          .returning()
          .then((r) => (r.length > 0 ? r[0] : null)),
      );

      if (!result)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update comment",
        );

      const updatedComment: APIPostComment = {
        ...result,
        author: comment.author,
        expressions: await resolveExpressions(
          result.content,
          result.expressionIds,
        ),
        expressionIds: (result.expressionIds ?? []).map((id) => id.toString()),
      };

      res.status(HttpStatusCode.Success).json(updatedComment);

      fireAndForgetAll([
        {
          label: "event:PostCommentUpdate",
          run: () =>
            emitEvent({
              event: "PostCommentUpdate",
              user_id: user.id,
              data: updatedComment,
            }),
        },
        {
          label: "cache:invalidate:postComments",
          run: () => invalidateCache("postComments", postId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId, commentId } = validatePostCommentParams.parse(req.params);

      const comment = await execNormalized<APIPostComment>(
        db.query.postCommentsTable.findFirst({
          where: and(
            eq(postCommentsTable.id, BigInt(commentId)),
            eq(postCommentsTable.postId, BigInt(postId)),
          ),
        }),
      );

      if (!comment)
        throw new HttpException(HttpStatusCode.NotFound, "Comment not found");

      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, BigInt(postId)),
        }),
      );

      const isAuthor = BigInt(comment.authorId) === BigInt(user.id);
      const isPostAuthor = post && BigInt(post.authorId) === BigInt(user.id);

      if (!isAuthor && !isPostAuthor)
        throw new HttpException(HttpStatusCode.Forbidden, "Missing permission");

      await db
        .delete(postCommentsTable)
        .where(eq(postCommentsTable.id, BigInt(commentId)));

      res.status(HttpStatusCode.Success).json({ id: comment.id, postId });

      fireAndForgetAll([
        {
          label: "event:PostCommentDelete",
          run: () =>
            emitEvent({
              event: "PostCommentDelete",
              user_id: user.id,
              data: { id: comment.id, postId },
            }),
        },
        {
          label: "cache:invalidate:postComments",
          run: () => invalidateCache("postComments", postId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
