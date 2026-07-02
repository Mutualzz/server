import { deleteCache } from "@mutualzz/cache";
import { db, postLikesTable, postsTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode, type APIPost } from "@mutualzz/types";
import { emitEvent, execNormalized, fireAndForgetAll } from "@mutualzz/util";
import { validatePostParams } from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class PostLikesController {
  static async add(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId } = validatePostParams.parse(req.params);

      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, BigInt(postId)),
        }),
      );

      if (!post)
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      await db
        .insert(postLikesTable)
        .values({ postId: BigInt(postId), userId: BigInt(user.id) })
        .onConflictDoNothing();

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:PostLikeAdd",
          run: () => {
            const notifyIds = [user.id, post.authorId.toString()];

            return Promise.all(
              notifyIds.map((id) =>
                emitEvent({
                  event: "PostLikeAdd",
                  user_id: id,
                  data: { postId, userId: user.id },
                }),
              ),
            );
          },
        },
        {
          label: "cache:delete:post",
          run: () => deleteCache("post", postId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId } = validatePostParams.parse(req.params);

      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, BigInt(postId)),
        }),
      );

      if (!post)
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      await db
        .delete(postLikesTable)
        .where(
          and(
            eq(postLikesTable.postId, BigInt(postId)),
            eq(postLikesTable.userId, BigInt(user.id)),
          ),
        );

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:PostLikeRemove",
          run: () => {
            const notifyIds = [user.id, post.authorId.toString()];

            return Promise.all(
              notifyIds.map((id) =>
                emitEvent({
                  event: "PostLikeRemove",
                  user_id: id,
                  data: { postId, userId: user.id },
                }),
              ),
            );
          },
        },
        {
          label: "cache:delete:post",
          run: () => deleteCache("post", postId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
