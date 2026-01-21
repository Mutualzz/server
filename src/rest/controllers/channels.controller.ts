import { deleteCache, setCache } from "@mutualzz/cache";
import { channelsTable, db } from "@mutualzz/database";
import type { APIChannel } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getChannel,
    getMember,
    getSpace,
    Snowflake,
} from "@mutualzz/util";
import {
    validateChannelBodyCreate,
    validateChannelBodyUpdate,
    validateChannelBulkBodyPatch,
    validateChannelParamsDelete,
    validateChannelParamsGet,
    validateChannelParamsUpdate,
    validateChannelQueryDelete,
} from "@mutualzz/validators";
import { eq, isNull, max, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

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

            if (
                channel.spaceId &&
                !(await getMember(channel.spaceId, user.id, true))
            )
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to view this channel",
                );

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

            const { name, type, parentId, spaceId } =
                validateChannelBodyCreate.parse(req.body);

            switch (type) {
                case ChannelType.Text:
                case ChannelType.Voice:
                case ChannelType.Category:
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

            if (spaceId) {
                const space = await getSpace(spaceId);

                if (!space)
                    throw new HttpException(
                        HttpStatusCode.NotFound,
                        "Space not found",
                    );

                if (BigInt(space.ownerId) !== BigInt(user.id))
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You do not have permission to create channels in this space",
                    );
            }

            const maxPosition = await db
                .select({ max: max(channelsTable.position) })
                .from(channelsTable)
                .where(
                    parentId
                        ? eq(channelsTable.parentId, BigInt(parentId))
                        : isNull(channelsTable.parentId),
                )
                .then((res) => res[0]?.max ?? 0);

            const channel = await execNormalized<APIChannel>(
                db
                    .insert(channelsTable)
                    .values({
                        // @ts-expect-error For some odd reason "id" is not recognized as a valid field
                        id: BigInt(Snowflake.generate()),
                        name,
                        type,
                        spaceId: spaceId ?? null,
                        parentId: parentId ?? null,
                        position: maxPosition + 1,
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

            await setCache("channel", `channel:${channel.id}`, channel);

            if (channel.spaceId) {
                await emitEvent({
                    event: "ChannelCreate",
                    space_id: channel.spaceId,
                    data: channel,
                });
            }

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

            if (channel.ownerId && BigInt(channel.ownerId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You do not have permission to update this channel",
                );

            const { name, topic, nsfw, parentId, position } =
                validateChannelBodyUpdate.parse(req.body);

            let newParentId;
            if (parentId != undefined) newParentId = BigInt(parentId);
            else
                newParentId = channel.parentId
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

            const channels = validateChannelBulkBodyPatch.parse(req.body);

            const updatedChannels = await Promise.all(
                channels.map(async (channelData) => {
                    const {
                        id,
                        name,
                        topic,
                        nsfw,
                        parentId,
                        position,
                        spaceId,
                    } = channelData;

                    if (!spaceId)
                        throw new HttpException(
                            HttpStatusCode.BadRequest,
                            "spaceId is required for bulk channel update",
                        );

                    const space = await getSpace(spaceId);

                    if (!space)
                        throw new HttpException(
                            HttpStatusCode.NotFound,
                            `Space with ID ${spaceId} not found`,
                        );

                    if (BigInt(space.ownerId) !== BigInt(user.id))
                        throw new HttpException(
                            HttpStatusCode.Forbidden,
                            "You do not have permission to update channels in this space",
                        );

                    const channel = await getChannel(id);

                    if (!channel)
                        throw new HttpException(
                            HttpStatusCode.NotFound,
                            `Channel with ID ${id} not found`,
                        );

                    const newParentId =
                        parentId === undefined
                            ? undefined
                            : parentId === null
                              ? sql`NULL`
                              : BigInt(parentId);

                    const newChannel = await execNormalized<APIChannel>(
                        db
                            .update(channelsTable)
                            .set({
                                name: name ?? channel.name,
                                topic: topic ?? channel.topic,
                                nsfw: nsfw ?? channel.nsfw,
                                parentId: newParentId,
                                position: position ?? channel.position,
                            })
                            .returning()
                            .where(eq(channelsTable.id, BigInt(channel.id)))
                            .then((res) => res[0]),
                    );

                    if (!newChannel)
                        throw new HttpException(
                            HttpStatusCode.InternalServerError,
                            `Failed to update channel with ID ${id}`,
                        );

                    await setCache("channel", newChannel.id, newChannel);

                    return newChannel;
                }),
            );

            await emitEvent({
                event: "BulkChannelUpdate",
                space_id: channels[0].spaceId,
                data: updatedChannels,
            });

            res.status(HttpStatusCode.Success).json(updatedChannels);
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

            const { parentOnly, spaceId } = validateChannelQueryDelete.parse(
                req.query,
            );

            if (spaceId) {
                const space = await getSpace(spaceId);

                if (!space)
                    throw new HttpException(
                        HttpStatusCode.NotFound,
                        "Space not found",
                    );

                if (BigInt(space.ownerId) !== BigInt(user.id))
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You do not have permission to delete channels in this space",
                    );
            }

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            let deletedChannels: APIChannel[] = [];

            if (parentOnly === false && channel.type === ChannelType.Category) {
                deletedChannels = await execNormalizedMany<APIChannel>(
                    db
                        .delete(channelsTable)
                        .where(eq(channelsTable.parentId, BigInt(channel.id)))
                        .returning(),
                );
            }

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
