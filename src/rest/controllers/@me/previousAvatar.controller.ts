import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { db, toPublicUser, usersTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, fireAndForgetAll, s3Client } from "@mutualzz/util";
import { validatePreviousAvatarDelete } from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { setCache } from "@mutualzz/cache";

// TODO: We need to call userupdate event in heres
export default class PreviousAvatarController {
  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { avatar: avatarHash } = validatePreviousAvatarDelete.parse(
        req.query,
      );

      if (!user.previousAvatars.includes(avatarHash))
        throw new HttpException(HttpStatusCode.NotFound, "Avatar not found");

      const isGif = avatarHash.startsWith("a_");
      const extName = isGif ? "gif" : "png";

      const nextPreviousAvatars = user.previousAvatars.filter(
        (avatar) => avatar !== avatarHash,
      );

      await db
        .update(usersTable)
        .set({
          previousAvatars: nextPreviousAvatars,
        })
        .where(eq(usersTable.id, BigInt(user.id)));

      // Delete from S3
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: `avatars/${user.id}/${avatarHash}.${extName}`,
        }),
      );

      user.previousAvatars = nextPreviousAvatars;

      res.status(HttpStatusCode.Success).json({
        avatar: avatarHash,
      });

      fireAndForgetAll([
        {
          label: "cache:set:authUser",
          run: () => setCache("authUser", user.id, user),
          meta: {
            userId: user.id,
          },
        },
        {
          label: "cache:set:user",
          run: () => setCache("user", user.id, toPublicUser(user)),
          meta: {
            userId: user.id,
          },
        },
      ]);
    } catch (error) {
      next(error);
    }
  }
}
