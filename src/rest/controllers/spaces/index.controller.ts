import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import { deleteCache, setCache } from "@mutualzz/cache";
import {
    channelsTable,
    db,
    rolesTable,
    spaceMembersTable,
    spacesTable,
    toPublicUser,
    userSettingsTable,
} from "@mutualzz/database";
import { spaceMemberRolesTable } from "@mutualzz/database/schemas/spaces/SpaceMemberRoles.ts";
import { generateHash } from "@mutualzz/rest/util";
import type {
    APIChannel,
    APIRole,
    APISpace,
    APISpaceMember,
    APIUserSettings,
} from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    bucketName,
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getMember,
    getSpace,
    s3Client,
    Snowflake,
} from "@mutualzz/util";
import { validateSpaceGet, validateSpacePut } from "@mutualzz/validators";
import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";

export default class SpacesController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { name } = validateSpacePut.parse(req.body);

            const { file: iconFile } = req;

            const spaceId = BigInt(Snowflake.generate());

            const spaceValues: typeof spacesTable.$inferInsert = {
                id: spaceId,
                name,
                ownerId: BigInt(user.id),
            };

            if (iconFile) {
                let crop = null;
                if (req.body.crop) crop = JSON.parse(req.body.crop);

                const isGif = iconFile.mimetype === "image/gif";

                let iconSharp: sharp.Sharp;
                if (isGif)
                    iconSharp = sharp(iconFile.buffer, { animated: true });
                else iconSharp = sharp(iconFile.buffer).toFormat("png");

                if (crop) {
                    const { x, y, width, height } = crop;
                    iconSharp = iconSharp.extract({
                        left: x,
                        top: y,
                        width,
                        height,
                    });
                }

                iconFile.buffer = await iconSharp.toBuffer();

                const iconHash = generateHash(
                    iconFile.buffer,
                    iconFile.mimetype.includes("gif"),
                );

                let existingIcon = null;
                const storedExt = isGif ? "gif" : "png";

                try {
                    const { Body } = await s3Client.send(
                        new GetObjectCommand({
                            Bucket: bucketName,
                            Key: `icons/${spaceId}/${iconHash}.${storedExt}`,
                        }),
                    );

                    existingIcon = Body;
                } catch {
                    // Ignore
                }

                if (!existingIcon) {
                    await s3Client.send(
                        new PutObjectCommand({
                            Bucket: bucketName,
                            Body: iconFile.buffer,
                            Key: `icons/${spaceId}/${iconHash}.${storedExt}`,
                            ContentType: isGif ? "image/gif" : "image/png",
                        }),
                    );
                }

                spaceValues.icon = iconHash;
            }

            const { space, settings } = await db.transaction(async (tx) => {
                const newSpace = await execNormalized<APISpace>(
                    tx
                        .insert(spacesTable)
                        .values(spaceValues)
                        .returning()
                        .then((results) => results[0]),
                );

                if (!newSpace)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create space",
                    );

                const everyoneRole = await execNormalized<APIRole>(
                    tx
                        .insert(rolesTable)
                        .values({
                            id: BigInt(newSpace.id),
                            name: "@everyone",
                            spaceId: BigInt(newSpace.id),
                        })
                        .returning()
                        .then((res) => res[0]),
                );

                if (!everyoneRole)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create default role",
                    );

                const newMember = await execNormalized<APISpaceMember>(
                    tx
                        .insert(spaceMembersTable)
                        .values({
                            spaceId: BigInt(newSpace.id),
                            userId: BigInt(user.id),
                        })
                        .returning()
                        .then((results) => results[0]),
                );

                await tx.insert(spaceMemberRolesTable).values({
                    spaceId: BigInt(newSpace.id),
                    userId: BigInt(user.id),
                    id: BigInt(everyoneRole.id),
                });

                if (!newMember)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create space member",
                    );

                const category = await execNormalized<APIChannel>(
                    tx
                        .insert(channelsTable)
                        .values({
                            id: BigInt(Snowflake.generate()),
                            type: ChannelType.Category,
                            spaceId: BigInt(newSpace.id),
                            name: "General",
                            position: 0,
                        })
                        .returning()
                        .then((results) => results[0]),
                );

                if (!category)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create default category",
                    );

                const defaultChannel = await execNormalized<APIChannel>(
                    tx
                        .insert(channelsTable)
                        .values({
                            id: BigInt(Snowflake.generate()),
                            type: ChannelType.Text, // Text
                            spaceId: BigInt(newSpace.id),
                            name: "General",
                            position: 0,
                            parentId: BigInt(category.id),
                        })
                        .returning()
                        .then((results) => results[0]),
                );

                if (!defaultChannel)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create default channel",
                    );

                const settings = await execNormalized<APIUserSettings>(
                    tx
                        .insert(userSettingsTable)
                        .values({
                            userId: BigInt(user.id),
                            spacePositions: [BigInt(newSpace.id)],
                        })
                        .onConflictDoUpdate({
                            target: userSettingsTable.userId,
                            set: {
                                spacePositions: sql`array_prepend(${newSpace.id}, COALESCE(${userSettingsTable.spacePositions}, ARRAY[]::bigint[]))`,
                            },
                        })
                        .returning()
                        .then((results) => results[0]),
                );

                if (!settings)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create user settings",
                    );

                await setCache("channel", category.id, category);
                await setCache("channel", defaultChannel.id, defaultChannel);
                await setCache(
                    "spaceMember",
                    `${newSpace.id}:${user.id}`,
                    newMember,
                );
                await setCache("space", newSpace.id, newSpace);
                await setCache("userSettings", user.id, settings);

                const channels = [category, defaultChannel];
                const roles = [everyoneRole];
                const members = [newMember];

                return {
                    space: {
                        ...newSpace,
                        channels,
                        roles,
                        members,
                        owner: toPublicUser(user),
                    },
                    settings,
                };
            });

            await emitEvent({
                event: "SpaceCreate",
                user_id: user.id,
                data: space,
            });

            await emitEvent({
                event: "UserSettingsUpdate",
                user_id: user.id,
                data: settings,
            });

            res.status(HttpStatusCode.Success).json(space);
        } catch (error) {
            next(error);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { id: spaceId } = req.params;

            const space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to delete this space",
                );

            if (space.icon) {
                const isGif = space.icon.startsWith("a_");
                const storedExt = isGif ? "gif" : "png";

                try {
                    await s3Client.send(
                        new DeleteObjectCommand({
                            Bucket: bucketName,
                            Key: `icons/${space.id}/${space.icon}.${storedExt}`,
                        }),
                    );
                } catch {
                    // Ignore
                }
            }

            const { settings, deletedSpace } = await db.transaction(
                async (tx) => {
                    const updatedSettings =
                        await execNormalized<APIUserSettings>(
                            tx
                                .update(userSettingsTable)
                                .set({
                                    spacePositions: sql`array_remove(${userSettingsTable.spacePositions}, ${space.id})`,
                                })
                                .where(
                                    eq(
                                        userSettingsTable.userId,
                                        BigInt(user.id),
                                    ),
                                )
                                .returning()
                                .then((results) => results[0]),
                        );

                    if (!updatedSettings)
                        throw new HttpException(
                            HttpStatusCode.InternalServerError,
                            "Failed to update user settings",
                        );

                    const deletedSpace = await execNormalized<APISpace>(
                        tx
                            .delete(spacesTable)
                            .where(eq(spacesTable.id, BigInt(space.id)))
                            .returning()
                            .then((results) => results[0]),
                    );

                    if (!deletedSpace)
                        throw new HttpException(
                            HttpStatusCode.InternalServerError,
                            "Failed to delete space",
                        );

                    await deleteCache("space", space.id);
                    await deleteCache("spaceMember", `${space.id}:${user.id}`);
                    await deleteCache("spaceMembers", space.id);
                    await setCache("userSettings", user.id, updatedSettings);

                    return {
                        settings: updatedSettings,
                        deletedSpace: deletedSpace,
                    };
                },
            );

            await emitEvent({
                event: "SpaceDelete",
                space_id: deletedSpace.id,
                data: deletedSpace,
            });

            await emitEvent({
                event: "UserSettingsUpdate",
                user_id: user.id,
                data: settings,
            });

            res.status(HttpStatusCode.Success).json(deletedSpace);
        } catch (error) {
            next(error);
        }
    }

    static async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const spaces = await execNormalizedMany<APISpace>(
                db.query.spacesTable.findMany({
                    where: sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.spaceId} = ${spacesTable.id} AND ${spaceMembersTable.userId} = ${user.id})`,
                }),
            );

            res.status(HttpStatusCode.Success).json(spaces);
        } catch (error) {
            next(error);
        }
    }

    static async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { id: spaceId } = validateSpaceGet.parse(req.params);

            let space = await getSpace(spaceId);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (!(await getMember(spaceId, user.id, true)))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to view this space",
                );

            res.status(HttpStatusCode.Success).json(space);
        } catch (error) {
            next(error);
        }
    }

    static async getBulk(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { limit } = req.query;

            const spaces = await execNormalizedMany<APISpace>(
                db.query.spacesTable.findMany({
                    limit: typeof limit === "string" ? parseInt(limit, 10) : 50,
                    where: sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.spaceId} = ${spacesTable.id} AND ${spaceMembersTable.userId} = ${user.id})`,
                }),
            );

            res.status(HttpStatusCode.Success).json(spaces);
        } catch (error) {
            next(error);
        }
    }
}
