import { deleteCache, setCache } from "@mutualzz/cache";
import { channelsTable, db } from "@mutualzz/database";
import type { APIChannel } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getChannel,
    getSpace,
    Snowflake,
    requireChannelPermissions,
    requireSpacePermissions,
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
import { eq, max, sql } from "drizzle-orm";
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

            const { name, type, parentId, spaceId, ownerId, recipientIds } =
                validateChannelBodyCreate.parse(req.body);

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

            let position: number | undefined | null = null;
            if (spaceId) {
                const space = await getSpace(spaceId);

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

                const maxPosition = await execNormalized<{
                    max: number | null;
                }>(
                    db
                        .select({ max: max(channelsTable.position) })
                        .from(channelsTable)
                        .where(eq(channelsTable.spaceId, BigInt(space.id))),
                );

                position = maxPosition?.max;
            }

            const channel = await execNormalized<APIChannel>(
                db
                    .insert(channelsTable)
                    .values({
                        id: BigInt(Snowflake.generate()),
                        type,
                        spaceId: spaceId ? BigInt(spaceId) : undefined,
                        name,
                        ownerId: ownerId ? BigInt(ownerId) : undefined,
                        position: (position ?? -1) + 1,
                        parentId: parentId ? BigInt(parentId) : undefined,
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

            if (channel.spaceId)
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

            let newParentId: bigint | null;
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

            const { spaceId, channels } = validateChannelBulkBodyPatch.parse(
                req.body,
            );

            const space = await getSpace(spaceId);
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

            const newChannels: APIChannel[] = [];
            for (const chBody of channels) {
                const channel = await getChannel(chBody.id);
                if (!channel)
                    throw new HttpException(
                        HttpStatusCode.NotFound,
                        `Channel with ID ${chBody.id} not found`,
                    );

                const newParentId =
                    chBody.parentId === undefined
                        ? undefined
                        : chBody.parentId === null
                          ? sql`NULL`
                          : BigInt(chBody.parentId);

                const newChannel = await execNormalized<APIChannel>(
                    db
                        .update(channelsTable)
                        .set({
                            name: chBody.name ?? channel.name,
                            topic: chBody.topic ?? channel.topic,
                            nsfw: chBody.nsfw ?? channel.nsfw,
                            parentId: newParentId,
                            position: chBody.position ?? channel.position,
                        })
                        .returning()
                        .where(eq(channelsTable.id, BigInt(channel.id)))
                        .then((res) => res[0]),
                );

                if (!newChannel)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        `Failed to update channel with ID ${chBody.id}`,
                    );

                await setCache("channel", newChannel.id, newChannel);

                newChannels.push(newChannel);
            }

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
