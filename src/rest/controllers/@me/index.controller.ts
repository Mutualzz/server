import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import { UserModel } from "@mutualzz/database";
import { defaultAvatars, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    bucketName,
    dominantHex,
    genRandColor,
    s3Client,
} from "@mutualzz/util";
import { validateMePatch } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import path from "path";
import sharp from "sharp";
import { emitEvent } from "util/Event";
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
                if (
                    user.avatar &&
                    !user.previousAvatars.includes(user.avatar)
                ) {
                    user.previousAvatars.unshift(user.avatar);
                    if (user.previousAvatars.length > 9) {
                        const removedAvatar = user.previousAvatars.pop();

                        if (removedAvatar) {
                            await s3Client.send(
                                new DeleteObjectCommand({
                                    Bucket: bucketName,
                                    Key: `avatars/${user.id}/${removedAvatar}`,
                                }),
                            );
                        }
                    }

                    user.markModified("previousAvatars");
                }

                const extName = path
                    .extname(avatarFile.originalname)
                    .replace(".", "");

                const crop = JSON.parse(req.body.crop);

                const { x, y, width, height } = crop;

                const isGif = avatarFile.mimetype === "image/gif";

                let avatarSharp;
                if (isGif)
                    avatarSharp = sharp(avatarFile.buffer, { animated: true });
                else avatarSharp = sharp(avatarFile.buffer).toFormat("png");

                avatarFile.buffer = await avatarSharp
                    .extract({
                        left: x,
                        top: y,
                        width,
                        height,
                    })
                    .toBuffer();

                const avatarHash = generateHash(
                    avatarFile.buffer,
                    avatarFile.mimetype.includes("gif"),
                );

                let existingAvatar = null;

                try {
                    const { Body } = await s3Client.send(
                        new GetObjectCommand({
                            Bucket: bucketName,
                            Key: `avatars/${user.id}/${avatarHash}.${extName}`,
                        }),
                    );

                    existingAvatar = Body;
                } catch {
                    // Ignore since the avatar is already assigned null
                }

                if (!existingAvatar) {
                    await s3Client.send(
                        new PutObjectCommand({
                            Bucket: bucketName,
                            Body: avatarFile.buffer,
                            Key: `avatars/${user.id}/${avatarHash}.${isGif ? "gif" : "png"}`,
                            ContentType: isGif ? "image/gif" : "image/png",
                        }),
                    );
                }

                user.avatar = avatarHash;
                user.accentColor = await dominantHex(avatarFile.buffer);
            }

            if (avatar !== undefined && !avatarFile) {
                if (avatar === null) {
                    if (
                        user.avatar &&
                        !user.previousAvatars.includes(user.avatar)
                    ) {
                        user.previousAvatars.unshift(user.avatar);
                        if (user.previousAvatars.length > 9) {
                            const removedAvatar = user.previousAvatars.pop();

                            if (removedAvatar) {
                                await s3Client.send(
                                    new DeleteObjectCommand({
                                        Bucket: bucketName,
                                        Key: `avatars/${user.id}/${removedAvatar}`,
                                    }),
                                );
                            }
                        }

                        user.markModified("previousAvatars");
                    }

                    user.avatar = null;
                    user.accentColor = genRandColor();
                } else if (avatar !== user.avatar) {
                    const isGif = avatar.startsWith("a_");
                    const storedExt = isGif ? "gif" : "png";

                    user.avatar = avatar;

                    const { Body: avatarObject } = await s3Client.send(
                        new GetObjectCommand({
                            Bucket: bucketName,
                            Key: `avatars/${user.id}/${avatar}.${storedExt}`,
                        }),
                    );
                    if (avatarObject) {
                        user.accentColor = await dominantHex(
                            (await avatarObject.transformToByteArray()) as Buffer,
                        );
                    }
                }
            }

            if (
                defaultAvatar &&
                defaultAvatar !== user.defaultAvatar &&
                defaultAvatars.includes(defaultAvatar)
            ) {
                user.avatar = null;
                user.defaultAvatar = defaultAvatar;
            }

            await user.save();

            await emitEvent({
                event: "UserUpdate",
                user_id: user.id,
                data: user,
            });

            res.status(HttpStatusCode.Success).json(user);
        } catch (err) {
            next(err);
        }
    }
}
