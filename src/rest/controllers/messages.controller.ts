import { deleteCache, getCache, setCache } from "@mutualzz/cache";
import { channelsTable, db, messagesTable } from "@mutualzz/database";
import type { APIMessage } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    buildEmbeds,
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getChannel,
    getMember,
    getUser,
    Snowflake,
} from "@mutualzz/util";
import {
    validateMessageBodyPut,
    validateMessageParamsPatch,
    validateMessageParamsPut,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class MessagesController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { channelId } = validateMessageParamsPut.parse(req.params);

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            if (
                channel.type !== ChannelType.Text &&
                channel.type !== ChannelType.DM &&
                channel.type !== ChannelType.GroupDM
            )
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Messages can only be sent in text channels",
                );

            const { content, nonce } = validateMessageBodyPut.parse(req.body);

            switch (channel.type) {
                case ChannelType.DM:
                case ChannelType.GroupDM:
                    if (
                        !channel.recipientIds ||
                        !channel.recipientIds.includes(user.id)
                    ) {
                        throw new HttpException(
                            HttpStatusCode.Forbidden,
                            "You are not part of this DM",
                        );
                    }
                    break;
                default:
                    if (
                        channel.spaceId &&
                        !(await getMember(channel.spaceId, user.id, true))
                    )
                        throw new HttpException(
                            HttpStatusCode.Forbidden,
                            "You are not a member of this space",
                        );
            }

            if (nonce) {
                const existingMessage = await execNormalized<APIMessage>(
                    db.query.messagesTable.findFirst({
                        with: {
                            channel: true,
                        },
                        where: and(
                            eq(messagesTable.nonce, BigInt(nonce)),
                            eq(messagesTable.channelId, BigInt(channel.id)),
                            eq(messagesTable.authorId, BigInt(user.id)),
                        ),
                    }),
                );

                if (existingMessage)
                    return res
                        .status(HttpStatusCode.Success)
                        .json(existingMessage);
            }

            const newMessage = await execNormalized<APIMessage>(
                db
                    .insert(messagesTable)
                    .values({
                        // @ts-ignore for some reason ID is not recognized as a field
                        id: BigInt(Snowflake.generate()),
                        authorId: user.id,
                        nonce: nonce ? BigInt(nonce) : undefined,
                        channelId: channel.id,
                        spaceId: channel.spaceId ?? null,
                        content: content ?? null,
                        embeds: await buildEmbeds(content),
                    })
                    .returning()
                    .then((r) => r[0]),
            );

            if (!newMessage)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create message",
                );

            await db
                .update(channelsTable)
                .set({
                    lastMessageId: BigInt(newMessage.id),
                })
                .where(eq(channelsTable.id, BigInt(channel.id)));

            const message = {
                ...newMessage,
                channel: channel,
                author: user,
            };

            await setCache("message", message.id, message);

            await emitEvent({
                event: "MessageCreate",
                channel_id: channel.id,
                data: message,
            });

            await emitEvent({
                event: "ChannelUpdate",
                channel_id: channel.id,
                data: {
                    id: channel.id,
                    lastMessageId: message.id,
                },
            });

            res.status(HttpStatusCode.Created).json(message);
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

            const { channelId, messageId } = validateMessageParamsPatch.parse(
                req.params,
            );

            const channel = await getChannel(channelId);
            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            let message = await getCache("message", messageId);
            if (!message)
                message = await execNormalized<APIMessage>(
                    db.query.messagesTable.findFirst({
                        with: {
                            author: true,
                            channel: true,
                        },
                        where: and(
                            eq(messagesTable.id, BigInt(messageId)),
                            eq(messagesTable.channelId, BigInt(channel.id)),
                        ),
                    }),
                );

            if (!message)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Message not found",
                );

            if (BigInt(message.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You can only edit your own messages",
                );

            const { content } = validateMessageBodyPut.parse(req.body);

            const result = await execNormalized<APIMessage>(
                db
                    .update(messagesTable)
                    .set({
                        content: content ?? message.content,
                        embeds: await buildEmbeds(content),
                        updatedAt: new Date(),
                    })
                    .where(eq(messagesTable.id, BigInt(message.id)))
                    .returning()
                    .then((r) => r[0]),
            );

            if (!result)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update message",
                );

            const newMessage = {
                ...result,
                channel,
                author: await getUser(message.authorId),
            };

            await setCache("message", messageId, newMessage);

            await emitEvent({
                event: "MessageUpdate",
                channel_id: channel.id,
                data: newMessage,
            });

            res.status(HttpStatusCode.Success).json(newMessage);
        } catch (err) {
            next(err);
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

            const { channelId } = req.params;

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
                    "You are not a member of this space",
                );

            if (
                channel.type === ChannelType.DM ||
                channel.type === ChannelType.GroupDM
            ) {
                if (
                    !channel.recipientIds ||
                    !channel.recipientIds.includes(user.id)
                ) {
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You are not part of this DM",
                    );
                }
            }

            if (
                channel.type !== ChannelType.Text &&
                channel.type !== ChannelType.DM &&
                channel.type !== ChannelType.GroupDM
            )
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Messages can only be fetched from text channels",
                );

            const aroundRaw = req.query.around
                ? `${req.query.around}`
                : undefined;
            const beforeRaw = req.query.before
                ? `${req.query.before}`
                : undefined;
            const afterRaw = req.query.after ? `${req.query.after}` : undefined;

            const limit = Math.max(
                1,
                Math.min(Number(req.query.limit) || 50, 100),
            );

            const nowSnowflake = BigInt(Snowflake.generate());
            const parseSnow = (v?: string) =>
                v ? BigInt(v).toString() : undefined;

            const around = aroundRaw ? parseSnow(aroundRaw) : undefined;
            const before = beforeRaw ? parseSnow(beforeRaw) : undefined;
            const after = afterRaw ? parseSnow(afterRaw) : undefined;

            if (limit < 1 || limit > 100)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Limit must be between 1 and 100",
                );

            if (before && BigInt(before) > nowSnowflake)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Before parameter cannot be in the future",
                );

            if (after && BigInt(after) > nowSnowflake)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "After parameter cannot be in the future",
                );

            let messages = await getCache(
                "messages",
                `${channel.id}-${around}-${before}-${after}-${limit}`,
            );

            if (messages)
                return res.status(HttpStatusCode.Success).json(messages);

            if (around) {
                const right = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                        },
                        where: and(
                            eq(messagesTable.channelId, BigInt(channelId)),
                            lt(messagesTable.id, BigInt(around)),
                        ),
                        orderBy: asc(messagesTable.createdAt),
                    }),
                );

                const left = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                        },
                        where: and(
                            eq(messagesTable.channelId, BigInt(channelId)),
                            gte(messagesTable.id, BigInt(around)),
                        ),
                        orderBy: asc(messagesTable.createdAt),
                    }),
                );

                messages = [...left, ...right].sort(
                    (a, b) =>
                        new Date(a.createdAt).getTime() -
                        new Date(b.createdAt).getTime(),
                );
            } else if (before) {
                messages = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                        },
                        where: and(
                            eq(messagesTable.channelId, BigInt(channelId)),
                            lt(messagesTable.id, BigInt(before)),
                        ),
                        orderBy: desc(messagesTable.createdAt),
                        limit,
                    }),
                );
            } else if (after) {
                messages = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                        },
                        where: and(
                            eq(messagesTable.channelId, BigInt(channelId)),
                            gte(messagesTable.id, BigInt(after)),
                        ),
                        orderBy: asc(messagesTable.createdAt),
                        limit,
                    }),
                );
            } else {
                messages = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                        },
                        where: eq(messagesTable.channelId, BigInt(channelId)),
                        orderBy: desc(messagesTable.createdAt),
                        limit,
                    }),
                );
            }

            res.status(HttpStatusCode.Success).json(messages);
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

            const { channelId, messageId } = req.params;

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            let message = await getCache("message", messageId);
            if (!message)
                message = await execNormalized<APIMessage>(
                    db.query.messagesTable.findFirst({
                        with: {
                            author: true,
                            channel: true,
                        },
                        where: and(
                            eq(messagesTable.id, BigInt(messageId)),
                            eq(messagesTable.channelId, BigInt(channel.id)),
                        ),
                    }),
                );

            if (!message)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Message not found",
                );

            if (BigInt(message.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You can only delete your own messages",
                );

            await db
                .delete(messagesTable)
                .where(eq(messagesTable.id, BigInt(message.id)));

            await deleteCache("message", messageId);

            await emitEvent({
                event: "MessageDelete",
                channel_id: channel.id,
                data: message,
            });

            res.status(HttpStatusCode.Success).json(message);
        } catch (err) {
            next(err);
        }
    }
}
