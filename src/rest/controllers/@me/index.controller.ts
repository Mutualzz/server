import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import { setCache } from "@mutualzz/cache";
import {
    db,
    toPublicUser,
    userSettingsTable,
    usersTable,
} from "@mutualzz/database";
import { logger } from "@mutualzz/rest/Logger";
import { generateHash } from "@mutualzz/rest/util";
import type { APIPrivateUser, APIUserSettings } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    bucketName,
    dominantHex,
    emitEvent,
    execNormalized,
    genRandColor,
    s3Client,
} from "@mutualzz/util";
import {
    validateMeSettingsUpdate,
    validateMeUpdate,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";

export default class MeController {
    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { username, avatar, defaultAvatar, globalName } =
                validateMeUpdate.parse(req.body);

            const { file: avatarFile } = req;

            if (avatarFile && avatar)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Provide either avatar file or avatar hash, not both",
                );

            if (defaultAvatar && avatar)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Provide either defaultAvatar or avatar, not both",
                );

            if (username && user.username !== username) {
                const exists = await db.query.usersTable.findFirst({
                    where: eq(usersTable.username, username),
                    columns: {},
                });

                if (exists)
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
                    if (user.previousAvatars.length >= 9) {
                        const removedAvatar = user.previousAvatars.pop();

                        if (removedAvatar) {
                            const isGif = removedAvatar.startsWith("a_");
                            const ext = isGif ? "gif" : "png";

                            await s3Client.send(
                                new DeleteObjectCommand({
                                    Bucket: bucketName,
                                    Key: `avatars/${user.id}/${removedAvatar}.${ext}`,
                                }),
                            );
                        }
                    }
                }

                let crop = null;

                if (req.body.crop) crop = JSON.parse(req.body.crop);

                const isGif = avatarFile.mimetype === "image/gif";

                let avatarSharp: sharp.Sharp;
                if (isGif)
                    avatarSharp = sharp(avatarFile.buffer, { animated: true });
                else avatarSharp = sharp(avatarFile.buffer).toFormat("png");

                if (crop) {
                    const { x, y, width, height } = crop;
                    avatarSharp = avatarSharp.extract({
                        left: x,
                        top: y,
                        width,
                        height,
                    });
                }

                avatarFile.buffer = await avatarSharp.toBuffer();

                const avatarHash = generateHash(
                    avatarFile.buffer,
                    avatarFile.mimetype.includes("gif"),
                );

                let existingAvatar = null;

                const storedExt = isGif ? "gif" : "png";

                try {
                    const { Body } = await s3Client.send(
                        new GetObjectCommand({
                            Bucket: bucketName,
                            Key: `avatars/${user.id}/${avatarHash}.${storedExt}`,
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
                            Key: `avatars/${user.id}/${avatarHash}.${storedExt}`,
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
                        user.avatar !== null &&
                        !user.previousAvatars.includes(user.avatar)
                    ) {
                        user.previousAvatars.unshift(user.avatar);
                        if (user.previousAvatars.length >= 9) {
                            const removedAvatar = user.previousAvatars.pop();

                            if (removedAvatar) {
                                const isGif = removedAvatar.startsWith("a_");
                                const extName = isGif ? "gif" : "png";

                                await s3Client.send(
                                    new DeleteObjectCommand({
                                        Bucket: bucketName,
                                        Key: `avatars/${user.id}/${removedAvatar}.${extName}`,
                                    }),
                                );
                            }
                        }
                    }

                    user.avatar = null;
                    user.accentColor = genRandColor();
                } else if (avatar !== user.avatar) {
                    if (!user.previousAvatars.includes(avatar))
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "Avatar not found in previous avatars",
                        );

                    const isGif = avatar.startsWith("a_");
                    if (isGif && !avatar.match(/^a_[a-f0-9]+$/i)) {
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "Invalid avatar hash format",
                        );
                    } else if (!isGif && !avatar.match(/^[a-f0-9]+$/i)) {
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "Invalid avatar hash format",
                        );
                    }

                    if (
                        user.avatar &&
                        !user.previousAvatars.includes(user.avatar)
                    ) {
                        user.previousAvatars.unshift(user.avatar);
                        if (user.previousAvatars.length >= 9) {
                            const removedAvatar = user.previousAvatars.pop();
                            // ...deletion logic...
                        }
                    }

                    user.previousAvatars = user.previousAvatars.filter(
                        (prevAvatar) => prevAvatar !== avatar,
                    );

                    const storedExt = isGif ? "gif" : "png";

                    user.avatar = avatar;

                    try {
                        const { Body: avatarObject } = await s3Client.send(
                            new GetObjectCommand({
                                Bucket: bucketName,
                                Key: `avatars/${user.id}/${avatar}.${storedExt}`,
                            }),
                        );
                        if (avatarObject) {
                            user.accentColor = await dominantHex(
                                Buffer.from(
                                    await avatarObject.transformToByteArray(),
                                ),
                            );
                        }
                    } catch (error) {
                        logger.warn(
                            `Avatar ${avatar} not found in S3 for user ${user.id}, using random color`,
                        );
                        user.accentColor = genRandColor();
                    }
                }
            }

            if (defaultAvatar) {
                if (
                    user.avatar &&
                    !user.previousAvatars.includes(user.avatar)
                ) {
                    user.previousAvatars.unshift(user.avatar);
                    if (user.previousAvatars.length >= 9) {
                        const removedAvatar = user.previousAvatars.pop();

                        if (removedAvatar) {
                            const isGif = removedAvatar.startsWith("a_");
                            const ext = isGif ? "gif" : "png";

                            await s3Client.send(
                                new DeleteObjectCommand({
                                    Bucket: bucketName,
                                    Key: `avatars/${user.id}/${removedAvatar}.${ext}`,
                                }),
                            );
                        }
                    }
                }

                user.avatar = null;

                user.defaultAvatar.type = defaultAvatar.type ?? 0;
                user.defaultAvatar.color = defaultAvatar.color ?? null;
                user.accentColor = defaultAvatar.color ?? genRandColor();
            }

            user.createdAt = new Date(user.createdAt);
            user.updatedAt = new Date();

            const newUser = await execNormalized<APIPrivateUser>(
                db
                    .update(usersTable)
                    .set({
                        ...user,
                        id: BigInt(user.id),
                    })
                    .where(eq(usersTable.id, BigInt(user.id)))
                    .returning()
                    .then((results) => results[0]),
            );

            if (!newUser)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update user",
                );

            await emitEvent({
                event: "UserUpdate",
                user_id: newUser.id,
                data: toPublicUser(newUser),
            });

            await setCache("user", user.id, newUser);

            res.status(HttpStatusCode.Success).json(toPublicUser(newUser));
        } catch (err) {
            next(err);
        }
    }

    static async updateSettings(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const { user } = req;

            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spacePositions, ...validatedSettings } =
                validateMeSettingsUpdate.parse(req.body);

            await db
                .insert(userSettingsTable)
                .values({
                    userId: BigInt(user.id),
                })
                .onConflictDoUpdate({
                    target: userSettingsTable.userId,
                    set: { userId: BigInt(user.id) },
                });

            const newSettings = {
                ...validatedSettings,
                ...(spacePositions && {
                    spacePositions: spacePositions.map(BigInt),
                }),
            };

            const result = await execNormalized<APIUserSettings>(
                db
                    .update(userSettingsTable)
                    .set(newSettings)
                    .where(eq(userSettingsTable.userId, BigInt(user.id)))
                    .returning()
                    .then((results) => results[0]),
            );

            if (!result)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update user settings",
                );

            await emitEvent({
                event: "UserSettingsUpdate",
                user_id: user.id,
                data: result,
            });

            await setCache("userSettings", user.id, result);

            res.status(HttpStatusCode.Success).json(result);
        } catch (error) {
            next(error);
        }
    }
}
