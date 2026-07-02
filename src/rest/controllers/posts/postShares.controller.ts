import { deleteCache } from "@mutualzz/cache";
import { db, postSharesTable, postsTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode, type APIPost } from "@mutualzz/types";
import {
  emitEvent,
  execNormalized,
  fireAndForgetAll,
  getFriendIds,
} from "@mutualzz/util";
import { validatePostParams } from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class PostSharesController {
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
        .insert(postSharesTable)
        .values({ postId: BigInt(postId), userId: BigInt(user.id) })
        .onConflictDoNothing();

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:PostShareAdd",
          run: async () => {
            const friendIds = await getFriendIds(user.id);
            const notifyIds = new Set([
              user.id,
              post.authorId.toString(),
              ...friendIds,
            ]);

            await Promise.all(
              [...notifyIds].map((id) =>
                emitEvent({
                  event: "PostShareAdd",
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
        .delete(postSharesTable)
        .where(
          and(
            eq(postSharesTable.postId, BigInt(postId)),
            eq(postSharesTable.userId, BigInt(user.id)),
          ),
        );

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:PostShareRemove",
          run: () =>
            emitEvent({
              event: "PostShareRemove",
              user_id: user.id,
              data: { postId, userId: user.id },
            }),
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
