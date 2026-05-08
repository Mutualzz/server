import {
    deleteCache,
    getCache,
    invalidateCache,
    setCache,
} from "@mutualzz/cache";
import { channelsTable, db, messagesTable } from "@mutualzz/database";
import type { APIMessage } from "@mutualzz/types";
import {
    ChannelType,
    HttpException,
    HttpStatusCode,
    MessageType,
} from "@mutualzz/types";
import {
    buildEmbeds,
    emitEvent,
    execNormalized,
    execNormalizedMany,
    fireAndForgetAll,
    getChannel,
    getMember,
    getSpace,
    getUser,
    requireChannelPermissions,
    sanitizeContent,
    Snowflake,
} from "@mutualzz/util";
import {
    validateChannelParamsGet,
    validateMessageBodyPut,
    validateMessageParamsModify,
    validateMessageParamsPut,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { BitField, type PermissionFlags } from "@mutualzz/bitfield";

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

            const isMessageSendable =
                channel.type === ChannelType.Voice ||
                channel.type === ChannelType.Text ||
                channel.type === ChannelType.DM ||
                channel.type === ChannelType.GroupDM;

            if (!isMessageSendable)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Message cannot be sent in this channel",
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

            if (channel.spaceId)
                await requireChannelPermissions({
                    channelId: channel.id,
                    userId: user.id,
                    needed: ["ViewChannel", "SendMessages"],
                });

            if (nonce) {
                let existingMessage = await getCache("message", nonce);
                if (existingMessage)
                    return res
                        .status(HttpStatusCode.Success)
                        .json(existingMessage);

                existingMessage = await execNormalized<APIMessage>(
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

                if (existingMessage) {
                    await setCache("message", nonce, existingMessage);
                    return res
                        .status(HttpStatusCode.Success)
                        .json(existingMessage);
                }
            }

            let canUseExternalEmojis = false;
            let canEmbed = false;

            if (channel.spaceId) {
                try {
                    const { permissions } = await requireChannelPermissions({
                        channelId: channel.id,
                        userId: user.id,
                        needed: ["UseExternalEmojis", "EmbedLinks"],
                        mode: "Any",
                    });

                    canUseExternalEmojis = permissions.has("UseExternalEmojis");
                    canEmbed = permissions.has("EmbedLinks");
                } catch {
                    canUseExternalEmojis = false;
                    canEmbed = false;
                }
            }

            const sanitizedContent = content
                ? await sanitizeContent(content, channel, canUseExternalEmojis)
                : null;

            const newMessage = await execNormalized<APIMessage>(
                db
                    .insert(messagesTable)
                    .values({
                        id: BigInt(Snowflake.generate()),
                        authorId: BigInt(user.id),
                        nonce: nonce ? BigInt(nonce) : undefined,
                        channelId: BigInt(channel.id),
                        spaceId: channel.spaceId
                            ? BigInt(channel.spaceId)
                            : undefined,
                        content: sanitizedContent,
                        embeds: canEmbed
                            ? await buildEmbeds(sanitizedContent || "")
                            : [],
                        type: MessageType.Default,
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
                space: channel.spaceId ? await getSpace(channel.spaceId) : null,
            };

            res.status(HttpStatusCode.Created).json(message);

            fireAndForgetAll([
                {
                    label: "event:MessageCreate",
                    run: () =>
                        emitEvent({
                            event: "MessageCreate",
                            channel_id: channel.id,
                            data: message,
                        }),
                },
                {
                    label: "event:ChannelUpdate",
                    run: () =>
                        emitEvent({
                            event: "ChannelUpdate",
                            channel_id: channel.id,
                            data: {
                                id: channel.id,
                                lastMessageId: message.id,
                            },
                        }),
                },
                {
                    label: "cache:set:message",
                    run: () => setCache("message", message.id, message),
                },
                {
                    label: "cache:invalidate:messages",
                    run: () => invalidateCache("messages", channel.id),
                },
            ]);
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

            const { channelId, messageId } = validateMessageParamsModify.parse(
                req.params,
            );

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

            if (!content || content.length === 0) {
                await db
                    .delete(messagesTable)
                    .where(eq(messagesTable.id, BigInt(message.id)));

                res.status(HttpStatusCode.Success).json({
                    ...message,
                    content: "",
                    embeds: [],
                });

                fireAndForgetAll([
                    {
                        label: "event:MessageDelete",
                        run: () =>
                            emitEvent({
                                event: "MessageDelete",
                                channel_id: channel.id,
                                data: message,
                            }),
                    },
                    {
                        label: "cache:delete:message",
                        run: () => deleteCache("messages", messageId),
                    },
                    {
                        label: "cache:invalidate:messages",
                        run: () => invalidateCache("messages", channel.id),
                    },
                ]);

                return;
            }

            let canUseExternalEmojis = false;
            let canEmbed = false;

            if (channel.spaceId) {
                try {
                    const { permissions } = await requireChannelPermissions({
                        channelId: channel.id,
                        userId: user.id,
                        needed: ["UseExternalEmojis", "EmbedLinks"],
                        mode: "Any",
                    });
                    canUseExternalEmojis = permissions.has("UseExternalEmojis");
                    canEmbed = permissions.has("EmbedLinks");
                } catch {
                    canUseExternalEmojis = false;
                    canEmbed = false;
                }
            }

            const sanitizedContent = content
                ? await sanitizeContent(content, channel, canUseExternalEmojis)
                : content;

            const result = await execNormalized<APIMessage>(
                db
                    .update(messagesTable)
                    .set({
                        content: sanitizedContent,
                        embeds: canEmbed
                            ? await buildEmbeds(sanitizedContent || "")
                            : [],
                        edited: true,
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

            res.status(HttpStatusCode.Success).json(newMessage);

            fireAndForgetAll([
                {
                    label: "event:MessageUpdate",
                    run: () =>
                        emitEvent({
                            event: "MessageUpdate",
                            channel_id: channel.id,
                            data: newMessage,
                        }),
                },
                {
                    label: "cache:set:message",
                    run: () => setCache("message", messageId, newMessage),
                },
                {
                    label: "cache:invalidate:messages",
                    run: () => invalidateCache("messages", channel.id),
                },
            ]);
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

            if (channel.spaceId)
                await requireChannelPermissions({
                    channelId: channel.id,
                    userId: user.id,
                    needed: ["ViewChannel", "ReadMessageHistory"],
                });

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

            let cacheKey = `${channel.id}`;
            if (around) cacheKey += `-around-${around}`;
            if (before) cacheKey += `-before-${before}`;
            if (after) cacheKey += `-after-${after}`;
            cacheKey += `-limit-${limit}`;
            let messages = await getCache("messages", cacheKey);

            if (messages)
                return res.status(HttpStatusCode.Success).json(messages);

            if (around) {
                const right = await execNormalizedMany<APIMessage>(
                    db.query.messagesTable.findMany({
                        with: {
                            channel: true,
                            author: true,
                            space: true,
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
                            space: true,
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
                            space: true,
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
                            space: true,
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
                            space: true,
                        },
                        where: eq(messagesTable.channelId, BigInt(channelId)),
                        orderBy: desc(messagesTable.createdAt),
                        limit,
                    }),
                );
            }

            res.status(HttpStatusCode.Success).json(messages);

            void setCache("messages", cacheKey, messages);
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

            const { channelId, messageId } = validateMessageParamsModify.parse(
                req.params,
            );

            const channel = await getChannel(channelId);

            if (!channel)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Channel not found",
                );

            let permissions: BitField<PermissionFlags> | null = null;
            if (channel.spaceId) {
                const { permissions: perms } = await requireChannelPermissions({
                    channelId: channel.id,
                    userId: user.id,
                    needed: ["ViewChannel"],
                });

                permissions = perms;
            }

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

            const isAuthor = BigInt(message.authorId) === BigInt(user.id);
            const canModerate =
                Boolean(channel.spaceId) && permissions?.has("ManageMessages");

            if (!isAuthor && !canModerate)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "Missing permission",
                );

            await db
                .delete(messagesTable)
                .where(eq(messagesTable.id, BigInt(message.id)));

            res.status(HttpStatusCode.Success).json(message);

            fireAndForgetAll([
                {
                    label: "event:MessageDelete",
                    run: () =>
                        emitEvent({
                            event: "MessageDelete",
                            channel_id: channel.id,
                            data: {
                                id: message.id,
                                channelId: message.channelId,
                            },
                        }),
                },
                {
                    label: "cache:delete:message",
                    run: () => deleteCache("message", messageId),
                },
                {
                    label: "cache:invalidate:messages",
                    run: () => invalidateCache("messages", channel.id),
                },
            ]);
        } catch (err) {
            next(err);
        }
    }
}
