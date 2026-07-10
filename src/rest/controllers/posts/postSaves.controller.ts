import { deleteCache } from "@mutualzz/cache";
import { db, postSavesTable, postsTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode, type APIPost } from "@mutualzz/types";
import { execNormalized, fireAndForgetAll, assertNotBlocked } from "@mutualzz/util";
import { validatePostParams } from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class PostSavesController {
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

      await assertNotBlocked(user.id, post.authorId.toString(), "Post not found");

      await db
        .insert(postSavesTable)
        .values({ postId: BigInt(postId), userId: BigInt(user.id) })
        .onConflictDoNothing();

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
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
        .delete(postSavesTable)
        .where(
          and(
            eq(postSavesTable.postId, BigInt(postId)),
            eq(postSavesTable.userId, BigInt(user.id)),
          ),
        );

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
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
