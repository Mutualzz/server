import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import crypto from "crypto";
import { setCache } from "@mutualzz/cache";
import {
    db,
    toPublicUser,
    userSettingsTable,
    usersTable,
} from "@mutualzz/database";
import { logger } from "@mutualzz/rest";
import {
    bucketName,
    dominantHex,
    emitEvent,
    execNormalized,
    fireAndForgetAll,
    generateHash,
    genRandColor,
    postmark,
    redis,
    s3Client,
} from "@mutualzz/util";
import type { APIPrivateUser, APIUserSettings } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    imageFileValidator,
    validateChangePassword,
    validateMeSettingsUpdate,
    validateMeUpdate,
    validateUsernameChange,
    validateVerifyEmail,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { BitField, userFlags } from "@mutualzz/bitfield";
import bcrypt from "bcrypt";
import { BCRYPT_SALT_ROUNDS } from "@mutualzz/rest/util";
import { z } from "zod";

export default class MeController {
    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { avatar, defaultAvatar, globalName } =
                validateMeUpdate.parse(req.body);

            const avatarFile = imageFileValidator.parse(req.file);

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

            if (globalName && globalName !== user.globalName)
                user.globalName = globalName;

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

                const isGif = avatarFile.mimetype === "image/gif";
                let buffer: Buffer | Uint8Array = avatarFile.buffer;

                let expressionSharp: sharp.Sharp;
                if (isGif) {
                    expressionSharp = sharp(buffer, {
                        animated: true,
                    });

                    if (req.body.crop) {
                        const { x, y, width, height } = JSON.parse(
                            req.body.crop,
                        );
                        expressionSharp = expressionSharp.extract({
                            left: x,
                            top: y,
                            width,
                            height,
                        });

                        buffer = await expressionSharp.toBuffer();
                    }
                }

                const avatarHash = generateHash(
                    buffer,
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
                            Body: buffer,
                            Key: `avatars/${user.id}/${avatarHash}.${storedExt}`,
                            ContentType: isGif ? "image/gif" : "image/png",
                        }),
                    );
                }

                user.avatar = avatarHash;
                user.accentColor = await dominantHex(buffer);
            }

            if (avatar !== undefined && !avatarFile) {
                if (avatar === null) {
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

            res.status(HttpStatusCode.Success).json(toPublicUser(newUser));

            fireAndForgetAll([
                {
                    label: "event:UserUpdate",
                    run: () =>
                        emitEvent({
                            event: "UserUpdate",
                            user_id: newUser.id,
                            data: toPublicUser(newUser),
                        }),
                    meta: { userId: user.id },
                },
                {
                    label: "cache:update:user",
                    run: () => setCache("user", user.id, toPublicUser(newUser)),
                    meta: {
                        userId: user.id,
                    },
                },
                {
                    label: "cache:update:authUser",
                    run: () => setCache("authUser", user.id, newUser),
                },
            ]);
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

            res.status(HttpStatusCode.Success).json(result);

            fireAndForgetAll([
                {
                    label: "event:UserSettingsUpdate",
                    run: () =>
                        emitEvent({
                            event: "UserSettingsUpdate",
                            user_id: user.id,
                            data: result,
                        }),
                    meta: {
                        userId: user.id,
                    },
                },
                {
                    label: "cache:set:userSettings",
                    run: () => setCache("userSettings", user.id, result),
                    meta: { userId: user.id },
                },
            ]);
        } catch (error) {
            next(error);
        }
    }

    static async verifyEmail(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { code } = validateVerifyEmail.parse(req.body);

            const key = `emailVerify:${user.id}`;
            const storedCode = await redis.get(key);

            if (!storedCode)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid verification code",
                    [
                        {
                            path: "code",
                            message: "Invalid verification code",
                        },
                    ],
                );

            if (storedCode !== code)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid verification code",
                    [
                        {
                            path: "code",
                            message: "Invalid verification code",
                        },
                    ],
                );

            await redis.del(key);
            await redis.del(`emailVerifyCooldown:${user.id}`);

            const currentUserFlags = BitField.fromString(
                userFlags,
                user.flags.toString(),
            );

            currentUserFlags.add("Verified");

            const updatedUser = await execNormalized<APIPrivateUser>(
                db
                    .update(usersTable)
                    .set({
                        flags: currentUserFlags.toBigInt(),
                    })
                    .returning()
                    .where(eq(usersTable.id, BigInt(user.id)))
                    .then((results) => results[0]),
            );

            if (!updatedUser)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to verify email",
                );

            res.status(HttpStatusCode.Success).json(toPublicUser(updatedUser));

            fireAndForgetAll([
                {
                    label: "event:UserUpdate",
                    run: () =>
                        emitEvent({
                            event: "UserUpdate",
                            user_id: updatedUser.id,
                            data: updatedUser,
                        }),
                },
                {
                    label: "cache:update:user",
                    run: () =>
                        setCache("user", user.id, toPublicUser(updatedUser)),
                    meta: {
                        userId: user.id,
                    },
                },
                {
                    label: "cache:update:authUser",
                    run: () => setCache("authUser", user.id, updatedUser),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async changeEmail(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { code, email } = z
                .object({
                    code: z.string().trim(),
                    email: z.email().trim(),
                })
                .parse(req.body);

            if (email === user.email)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "The email cannot be same as the old one",
                    [
                        {
                            path: "email",
                            message: "The email cannot be same as the old one",
                        },
                    ],
                );

            const emailExists = await db.query.usersTable.findFirst({
                columns: {
                    email: true,
                },
                where: eq(usersTable.email, email),
            });

            if (emailExists)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "This email is already taken",
                    [
                        {
                            path: "email",
                            message: "This email is already taken",
                        },
                    ],
                );

            const key = `emailConfirm:${user.id}`;
            const storedCode = await redis.get(key);

            if (!storedCode)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid confirmation code",
                    [
                        {
                            path: "code",
                            message: "Invalid confirmation code",
                        },
                    ],
                );

            if (storedCode !== code)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid verification code",
                    [
                        {
                            path: "code",
                            message: "Invalid confirmation code",
                        },
                    ],
                );

            await redis.del(key);
            await redis.del(`emailConfirmCooldown:${user.id}`);

            const currentUserFlags = BitField.fromString(
                userFlags,
                user.flags.toString(),
            );

            currentUserFlags.remove("Verified");

            const updatedUser = await execNormalized<APIPrivateUser>(
                db
                    .update(usersTable)
                    .set({
                        email,
                        flags: currentUserFlags.toBigInt(),
                    })
                    .returning()
                    .where(eq(usersTable.id, BigInt(user.id)))
                    .then((results) => results[0]),
            );

            if (!updatedUser)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to change email",
                );

            res.status(HttpStatusCode.Success).json(toPublicUser(updatedUser));

            fireAndForgetAll([
                {
                    label: "event:UserUpdate",
                    run: () =>
                        emitEvent({
                            event: "UserUpdate",
                            user_id: updatedUser.id,
                            data: updatedUser,
                        }),
                },
                {
                    label: "cache:update:user",
                    run: () =>
                        setCache("user", user.id, toPublicUser(updatedUser)),
                    meta: {
                        userId: user.id,
                    },
                },
                {
                    label: "cache:update:authUser",
                    run: () => setCache("authUser", user.id, updatedUser),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async changeUsername(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        const { user } = req;
        if (!user)
            throw new HttpException(
                HttpStatusCode.Unauthorized,
                "Unauthorized",
            );

        const { username, password } = validateUsernameChange.parse(req.body);

        if (username === user.username)
            throw new HttpException(
                HttpStatusCode.BadRequest,
                "The new username cannot be same as the old one",
                [
                    {
                        path: "username",
                        message:
                            "The new username cannot be same as the old one",
                    },
                ],
            );

        const usernameExists = await db.query.usersTable.findFirst({
            columns: {
                username: true,
            },
            where: eq(usersTable.username, username),
        });

        if (usernameExists)
            throw new HttpException(
                HttpStatusCode.Forbidden,
                "This username is already taken",
                [
                    {
                        path: "username",
                        message: "This username is already taken",
                    },
                ],
            );

        const dbUser = await db.query.usersTable.findFirst({
            columns: {
                hash: true,
            },
            where: eq(usersTable.id, BigInt(user.id)),
        });

        if (!dbUser)
            throw new HttpException(
                HttpStatusCode.Unauthorized,
                "Unauthorized",
            );

        const correctPassword = await bcrypt.compare(password, dbUser.hash);

        if (!correctPassword)
            throw new HttpException(
                HttpStatusCode.BadRequest,
                "Password is incorrect",
                [
                    {
                        path: "password",
                        message: "Password is incorrect",
                    },
                ],
            );

        const updatedUser = await execNormalized<APIPrivateUser>(
            db
                .update(usersTable)
                .set({
                    username,
                })
                .where(eq(usersTable.id, BigInt(user.id)))
                .returning()
                .then((results) => results[0]),
        );

        if (!updatedUser)
            throw new HttpException(
                HttpStatusCode.InternalServerError,
                "Failed to change password",
            );

        res.status(HttpStatusCode.Success).json(toPublicUser(updatedUser));

        fireAndForgetAll([
            {
                label: "event:UserUpdate",
                run: () =>
                    emitEvent({
                        event: "UserUpdate",
                        user_id: updatedUser.id,
                        data: updatedUser,
                    }),
            },
            {
                label: "cache:update:user",
                run: () => setCache("user", user.id, toPublicUser(updatedUser)),
                meta: {
                    userId: user.id,
                },
            },
            {
                label: "cache:update:authUser",
                run: () => setCache("authUser", user.id, updatedUser),
            },
        ]);
    }

    static async changeEmailUnverified(
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

            const currentUserFlags = BitField.fromString(
                userFlags,
                user.flags.toString(),
            );

            console.log(currentUserFlags.toArray());

            if (currentUserFlags.has("Verified"))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot use this endpoint if your email is already verified",
                );

            const { email } = z
                .object({
                    email: z.email().trim(),
                })
                .parse(req.body);

            if (email === user.email)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "The email cannot be same as the old one",
                );

            const emailExists = await db.query.usersTable.findFirst({
                columns: {
                    email: true,
                },
                where: eq(usersTable.email, email),
            });

            if (emailExists)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "This email is already taken",
                );

            const updatedUser = await execNormalized<APIPrivateUser>(
                db
                    .update(usersTable)
                    .set({
                        email,
                    })
                    .returning()
                    .where(eq(usersTable.id, BigInt(user.id)))
                    .then((results) => results[0]),
            );

            if (!updatedUser)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to change email",
                );

            res.status(HttpStatusCode.Success).json(toPublicUser(updatedUser));

            fireAndForgetAll([
                {
                    label: "event:UserUpdate",
                    run: () =>
                        emitEvent({
                            event: "UserUpdate",
                            user_id: updatedUser.id,
                            data: updatedUser,
                        }),
                },
                {
                    label: "cache:update:user",
                    run: () =>
                        setCache("user", user.id, toPublicUser(updatedUser)),
                    meta: {
                        userId: user.id,
                    },
                },
                {
                    label: "cache:update:authUser",
                    run: () => setCache("authUser", user.id, updatedUser),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }

    static async sendEmailCode(
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

            const cooldownKey = `emailVerifyCooldown:${user.id}`;
            const onCooldown = await redis.get(cooldownKey);

            if (onCooldown) {
                res.status(HttpStatusCode.Success).json({
                    success: true,
                });

                return;
            }

            const code = crypto
                .randomInt(0, 999_999)
                .toString()
                .padStart(6, "0");
            const redisKey = `emailVerify:${user.id}`;

            await redis.set(redisKey, code, "EX", 900);
            await redis.set(cooldownKey, "1", "EX", 60);

            const sentEmail = await postmark.sendEmailWithTemplate({
                From: "verify@mutualzz.com",
                To: user.email,
                MessageStream: "email-verification",
                TemplateAlias: "email-verification",
                TemplateModel: {
                    code,
                    email: user.email,
                },
            });

            if (sentEmail.ErrorCode !== 0)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to send verification email",
                );

            res.status(HttpStatusCode.Success).json({
                success: true,
            });
        } catch (err) {
            next(err);
        }
    }

    static async confirmEmail(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const cooldownKey = `emailConfirmCooldown:${user.id}`;
            const onCooldown = await redis.get(cooldownKey);

            if (onCooldown) {
                res.status(HttpStatusCode.Success).json({
                    success: true,
                });

                return;
            }

            const code = crypto
                .randomInt(0, 999_999)
                .toString()
                .padStart(6, "0");

            const redisKey = `emailConfirm:${user.id}`;

            await redis.set(redisKey, code, "EX", 900);
            await redis.set(cooldownKey, "1", "EX", 60);

            const sentEmail = await postmark.sendEmailWithTemplate({
                From: "confirm@mutualzz.com",
                To: user.email,
                MessageStream: "email-confirm",
                TemplateAlias: "email-confirm",
                TemplateModel: {
                    code,
                    email: user.email,
                },
            });

            if (sentEmail.ErrorCode !== 0)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to send confirm email",
                );

            res.status(HttpStatusCode.Success).json({
                success: true,
            });
        } catch (err) {
            next(err);
        }
    }

    static async changePassword(
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

            const { currentPassword, newPassword } =
                validateChangePassword.parse(req.body);

            const dbUser = await db.query.usersTable.findFirst({
                columns: {
                    hash: true,
                },
                where: eq(usersTable.id, BigInt(user.id)),
            });

            if (!dbUser)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const correctCurrentPassword = await bcrypt.compare(
                currentPassword,
                dbUser.hash,
            );

            if (!correctCurrentPassword)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Current password is incorrect",
                    [
                        {
                            path: "currentPassword",
                            message: "Current Password is incorrect",
                        },
                    ],
                );

            const newHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);

            const updatedUser = await execNormalized<APIPrivateUser>(
                db
                    .update(usersTable)
                    .set({
                        hash: newHash,
                    })
                    .where(eq(usersTable.id, BigInt(user.id)))
                    .returning()
                    .then((results) => results[0]),
            );

            if (!updatedUser)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to change password",
                );

            res.status(HttpStatusCode.Success).json({
                success: true,
            });
        } catch (err) {
            next(err);
        }
    }
}
