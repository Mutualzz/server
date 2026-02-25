import { deleteCache, invalidateCache, setCache } from "@mutualzz/cache";
import { channelsTable, db } from "@mutualzz/database";
import type { APIChannel } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    bucketName,
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getChannel,
    getSpaceHydrated,
    requireChannelPermissions,
    requireSpacePermissions,
    s3Client,
    Snowflake,
} from "@mutualzz/util";
import {
    fileValidator,
    validateChannelBodyCreate,
    validateChannelBodyUpdate,
    validateChannelBulkBodyPatch,
    validateChannelParamsDelete,
    validateChannelParamsGet,
    validateChannelParamsUpdate,
    validateChannelQueryDelete,
} from "@mutualzz/validators";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { generateHash } from "@mutualzz/rest/util";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export default class ChannelsController {
    static async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { channelId } = validateChannelParamsGet.parse(req.params);

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            if (channel.spaceId)
                await requireChannelPermissions({
                    channelId: channel.id,
                    userId: user.id,
                    needed: ["ViewChannel"],
                });

            if (channel.recipientIds && !channel.recipientIds.includes(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to view this channel",
                );

            res.status(HttpStatusCode.Success).json(channel);
        } catch (err) {
            next(err);
        }
    }

    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            let rawCrop;
            if (req.body.crop) rawCrop = JSON.parse(req.body.crop);

            const {
                name,
                parentId,
                spaceId,
                ownerId,
                recipientIds,
                crop,
                ...rest
            } = validateChannelBodyCreate.parse({
                ...req.body,
                crop: rawCrop,
            });

            const type = parseInt(rest.type) as ChannelType;

            switch (type) {
                case ChannelType.Text:
                case ChannelType.Voice:
                case ChannelType.Category:
                    if (ownerId || recipientIds)
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "Space channels cannot have an owner or recipient ids",
                        );
                    break;
                case ChannelType.DM:
                case ChannelType.GroupDM: {
                    if (spaceId)
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "Cannot create DM or Group DM channels in spaces",
                            [
                                {
                                    path: "type",
                                    message:
                                        "Cannot create DM or Group DM channels in spaces",
                                },
                            ],
                        );

                    if (parentId)
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "DM or Group DM channels cannot have parent id",
                        );
                    break;
                }
                default:
                    throw new HttpException(
                        HttpStatusCode.BadRequest,
                        "Invalid channel type",
                        [
                            {
                                path: "type",
                                message: "Invalid channel type",
                            },
                        ],
                    );
            }
            if (!spaceId) {
                const channel = await execNormalized<APIChannel>(
                    db
                        .insert(channelsTable)
                        .values({
                            id: BigInt(Snowflake.generate()),
                            type,
                            name,
                            ownerId: ownerId ? BigInt(ownerId) : undefined,
                            parentId: null,
                            recipientIds: recipientIds
                                ? recipientIds.map((id) => BigInt(id))
                                : undefined,
                            flags: 0n,
                        })
                        .returning()
                        .then((res) => res[0]),
                ).then(async (channel) => {
                    if (!channel) return null;
                    return channel.parentId
                        ? {
                              ...channel,
                              parent: await getChannel(channel.parentId),
                          }
                        : channel;
                });

                if (!channel)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create channel",
                    );

                await setCache("channel", channel.id, channel);

                // TODO: Implement proper events for DM and Group DM channels
                // await emitEvent({
                //     event: "ChannelCreate",
                //     user_id: channel.id,
                //     data: channel,
                // });

                res.status(HttpStatusCode.Created).json(channel);
                return;
            }

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            await requireSpacePermissions({
                spaceId,
                userId: user.id,
                needed: ["ManageChannels"],
            });

            const iconFile = fileValidator.optional().parse(req.file);

            const channelValues: typeof channelsTable.$inferInsert = {
                id: BigInt(Snowflake.generate()),
                type,
                spaceId: BigInt(space.id),
                name,
                parentId: parentId == null ? null : BigInt(parentId),
                flags: 0n,
            };

            if (iconFile) {
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
                            Key: `icons/channels/${channelValues.id}/${iconHash}.${storedExt}`,
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
                            Key: `icons/channels/${channelValues.id}/${iconHash}.${storedExt}`,
                            ContentType: isGif ? "image/gif" : "image/png",
                        }),
                    );
                }

                channelValues.icon = iconHash;
            }

            const created = await execNormalized<APIChannel>(
                db.transaction(async (tx) => {
                    const lockKey = `${space.id}:${parentId ?? "root"}`;
                    await tx.execute(
                        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
                    );

                    const parentWhere =
                        parentId == null
                            ? isNull(channelsTable.parentId)
                            : eq(channelsTable.parentId, BigInt(parentId));

                    const maxPositionRow = await tx
                        .select({ maxPos: max(channelsTable.position) })
                        .from(channelsTable)
                        .where(
                            and(
                                eq(channelsTable.spaceId, BigInt(space.id)),
                                parentWhere,
                            ),
                        )
                        .then((r) => r[0]);

                    const positionBase = maxPositionRow?.maxPos ?? null;

                    channelValues.position = (positionBase ?? -1) + 1;

                    const inserted = await tx
                        .insert(channelsTable)
                        .values(channelValues)
                        .returning()
                        .then((res) => res[0]);

                    return inserted ?? null;
                }),
            );

            const channel = await (async () => {
                if (!created) return null;
                return created.parentId
                    ? {
                          ...created,
                          parent: await getChannel(created.parentId),
                      }
                    : created;
            })();

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create channel",
                );

            await invalidateCache("spaceHydrated", spaceId);
            await setCache("channel", channel.id, channel);

            await emitEvent({
                event: "ChannelCreate",
                space_id: channel.spaceId,
                data: channel,
            });

            res.status(HttpStatusCode.Created).json(channel);
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { channelId } = validateChannelParamsUpdate.parse(req.params);

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            if (channel.type === ChannelType.DM)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot update DM channels",
                );

            if (channel.spaceId) {
                await requireSpacePermissions({
                    spaceId: channel.spaceId,
                    userId: user.id,
                    needed: ["ManageChannels"],
                });
            } else if (
                channel.ownerId &&
                BigInt(channel.ownerId) !== BigInt(user.id)
            ) {
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to update this channel",
                );
            }

            const { name, topic, nsfw, parentId, position } =
                validateChannelBodyUpdate.parse(req.body);

            const newParentId: bigint | null | undefined =
                parentId !== undefined
                    ? parentId === null
                        ? null
                        : BigInt(parentId)
                    : channel.parentId
                      ? BigInt(channel.parentId)
                      : null;

            const updatedChannel = await execNormalized<APIChannel>(
                db
                    .update(channelsTable)
                    .set({
                        name: name ?? channel.name,
                        topic: topic ?? channel.topic,
                        nsfw: nsfw ?? channel.nsfw,
                        parentId: newParentId,
                        position: position ?? channel.position,
                    })
                    .where(eq(channelsTable.id, BigInt(channel.id)))
                    .returning()
                    .then((res) => res[0]),
            );

            if (!updatedChannel)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update channel",
                );

            if (updatedChannel.spaceId)
                await invalidateCache("spaceHydrated", updatedChannel.spaceId);
            await setCache("channel", updatedChannel.id, updatedChannel);

            await emitEvent({
                event: "ChannelUpdate",
                channel_id: channel.id,
                data: updatedChannel,
            });

            res.status(HttpStatusCode.Success).json(updatedChannel);
        } catch (err) {
            next(err);
        }
    }

    static async updateBulk(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, channels } = validateChannelBulkBodyPatch.parse(
                req.body,
            );

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            await requireSpacePermissions({
                spaceId: space.id,
                userId: user.id,
                needed: ["ManageChannels"],
            });

            const newChannels: APIChannel[] = await db.transaction(
                async (tx) => {
                    const updated: APIChannel[] = [];

                    for (const chBody of channels) {
                        const channel = await getChannel(chBody.id);
                        if (!channel)
                            throw new HttpException(
                                HttpStatusCode.NotFound,
                                `Channel with ID ${chBody.id} not found`,
                            );

                        if (!channel.spaceId || channel.spaceId !== spaceId)
                            throw new HttpException(
                                HttpStatusCode.BadRequest,
                                `Channel ${chBody.id} does not belong to space ${spaceId}`,
                            );

                        const nextParentId: bigint | null | undefined =
                            chBody.parentId === undefined
                                ? undefined
                                : chBody.parentId === null
                                  ? null
                                  : BigInt(chBody.parentId);

                        const newChannel = await execNormalized<APIChannel>(
                            tx
                                .update(channelsTable)
                                .set({
                                    name: chBody.name ?? channel.name,
                                    topic: chBody.topic ?? channel.topic,
                                    nsfw: chBody.nsfw ?? channel.nsfw,
                                    parentId: nextParentId,
                                    position:
                                        chBody.position ?? channel.position,
                                })
                                .where(eq(channelsTable.id, BigInt(channel.id)))
                                .returning()
                                .then((res) => res[0]),
                        );

                        if (!newChannel)
                            throw new HttpException(
                                HttpStatusCode.InternalServerError,
                                `Failed to update channel with ID ${chBody.id}`,
                            );

                        await setCache("channel", newChannel.id, newChannel);
                        updated.push(newChannel);
                    }

                    return updated;
                },
            );

            await invalidateCache("spaceHydrated", spaceId);
            await emitEvent({
                event: "BulkChannelUpdate",
                space_id: spaceId,
                data: newChannels,
            });

            res.status(HttpStatusCode.Success).json(newChannels);
        } catch (err) {
            next(err);
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

            const { channelId } = validateChannelParamsDelete.parse(req.params);
            const { parentOnly } = validateChannelQueryDelete.parse(req.query);

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            if (channel.spaceId) {
                await requireSpacePermissions({
                    spaceId: channel.spaceId,
                    userId: user.id,
                    needed: ["ManageChannels"],
                });
            } else if (
                channel.ownerId &&
                BigInt(channel.ownerId) !== BigInt(user.id)
            ) {
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to delete this channel",
                );
            }

            let deletedChannels: APIChannel[] = [];

            if (parentOnly === false && channel.type === ChannelType.Category)
                deletedChannels = await execNormalizedMany<APIChannel>(
                    db
                        .delete(channelsTable)
                        .where(eq(channelsTable.parentId, BigInt(channel.id)))
                        .returning(),
                );

            await db
                .delete(channelsTable)
                .where(eq(channelsTable.id, BigInt(channel.id)))
                .returning();

            if (parentOnly === false && channel.type === ChannelType.Category) {
                for (const ch of deletedChannels) {
                    await deleteCache("channel", ch.id);
                }

                await emitEvent({
                    event: "BulkChannelDelete",
                    data: deletedChannels,
                });

                res.status(HttpStatusCode.Success).json(deletedChannels);

                return;
            }

            if (channel.spaceId)
                await invalidateCache("spaceHydrated", channel.spaceId);
            await deleteCache("channel", channel.id);

            await emitEvent({
                event: "ChannelDelete",
                channel_id: channel.id,
                data: channel,
            });

            res.status(HttpStatusCode.Success).json(channel);
        } catch (err) {
            next(err);
        }
    }
}
