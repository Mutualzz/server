import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { db, usersTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, getUser, s3Client } from "@mutualzz/util";
import { validatePreviousAvatarDelete } from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class PreviousAvatarController {
    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { avatar: avatarHash } = validatePreviousAvatarDelete.parse(
                req.query,
            );

            if (!avatarHash)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Avatar hash is required",
                );

            if (!user.previousAvatars.includes(avatarHash))
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Avatar not found",
                );

            const isGif = avatarHash.startsWith("a_");
            const extName = isGif ? "gif" : "png";

            await db
                .update(usersTable)
                .set({
                    previousAvatars: user.previousAvatars.filter(
                        (avatar) => avatar !== avatarHash,
                    ),
                })
                .where(eq(usersTable.id, user.id));

            // Delete from S3
            await s3Client.send(
                new DeleteObjectCommand({
                    Bucket: bucketName,
                    Key: `avatars/${user.id}/${avatarHash}.${extName}`,
                }),
            );

            res.status(HttpStatusCode.Success).json({
                avatar: avatarHash,
            });
        } catch (error) {
            next(error);
        }
    }
}
