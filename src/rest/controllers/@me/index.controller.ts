import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import { UserModel } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, dominantHex, s3Client } from "@mutualzz/util";
import { validateMePatch } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import { generateHash } from "../../utils";

export default class MeController {
    static async patchMe(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await UserModel.findById(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { username, avatar, defaultAvatar, globalName } =
                validateMePatch.parse(req.body);

            const { file: avatarFile } = req;

            if (username && user.username !== username) {
                if (await UserModel.findOne({ username }))
                    throw new HttpException(
                        HttpStatusCode.BadRequest,
                        "Username already taken",
                        [
                            {
                                path: "username",
                                message: "Username already taken",
                            },
                        ],
                    );

                user.username = username;
            }

            if (globalName && globalName !== user.globalName) {
                user.globalName = globalName;
            }

            if (avatarFile) {
                if (user.avatar) {
                    user.previousAvatars.push(user.avatar);
                    if (user.previousAvatars.length > 5) {
                        const removedAvatar = user.previousAvatars.shift();

                        if (removedAvatar) {
                            await s3Client.send(
                                new DeleteObjectCommand({
                                    Bucket: bucketName,
                                    Key: `avatars/${user.id}/${removedAvatar}`,
                                }),
                            );
                        }
                    }
                }

                const avatarHash = generateHash(
                    avatarFile.buffer,
                    avatarFile.mimetype.includes("gif"),
                );

                const { Body: existingAvatar } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: `avatars/${user.id}/${avatarHash}`,
                    }),
                );

                if (!existingAvatar) {
                    new PutObjectCommand({
                        Bucket: bucketName,
                        Body: avatarFile.buffer,
                        Key: `avatars/${user.id}/${avatarHash}`,
                        ContentType: avatarFile.mimetype,
                    });
                }

                user.avatar = avatarHash;
                user.accentColor = await dominantHex(avatarFile.buffer);
            }

            if (avatar) {
                user.avatar = avatar;

                const { Body: avatarObject } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: `avatars/${user.id}/${avatar}`,
                    }),
                );
                if (avatarObject) {
                    user.accentColor = await dominantHex(
                        (await avatarObject.transformToByteArray()) as Buffer,
                    );
                }
            }

            if (defaultAvatar) {
                user.avatar = null;
                user.defaultAvatar = defaultAvatar;
            }

            await user.save();

            res.status(HttpStatusCode.Success).json(user);
        } catch (err) {
            next(err);
        }
    }
}
