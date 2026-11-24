import {
  deleteCache,
  getCache,
  invalidateCache,
  setCache,
} from "@mutualzz/cache";
import { db, messagesTable } from "@mutualzz/database";
import {
  type APIMessage,
  ChannelType,
  HttpException,
  HttpStatusCode,
  MessageType,
  ReadStateType,
  NotificationLevel,
} from "@mutualzz/types";
import {
  buildEmbeds,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  filterByBlockedAuthors,
  filterVisibleChannelsForUser,
  fireAndForgetAll,
  getBlockedUserIds,
  getChannel,
  getChannels,
  getMember,
  getMemberRoles,
  getSpaceHydrated,
  getUser,
  isChannelRecipient,
  publicUserColumns,
  requireChannelPermissions,
  resolveExpressions,
  attachReactionsToMessages,
  hydrateMessagesForResponse,
  sanitizeContent,
  setChannelLastMessageId,
  Snowflake,
  serializeReadState,
  computeMutedUntilDuration,
} from "@mutualzz/util";
import { patchChannelNotificationSettingsSchema } from "@mutualzz/validators";
import {
  messagesGetQuery,
  validateChannelParamsGet,
  validateMessageAckParams,
  validateMessageBodyPatch,
  validateMessageBodyPut,
  validateMessageParamsModify,
  validateMessageParamsPut,
  validateSpaceGetOneParams,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  BitField,
  readStateFlags,
  type PermissionFlags,
} from "@mutualzz/bitfield";
import { createMessage } from "@mutualzz/util/messages/createMessage";
import { readAttachmentSpoilers } from "@mutualzz/util/messages/attachments";
import {
  buildMessageSearchWhere,
  combineMessageSearchWhere,
} from "../../util/messageSearch";
import { readStatesTable } from "@mutualzz/database/schemas/ReadState";
import { z } from "zod";

const messageSearchQuerySchema = z.string().trim().min(1).max(200);

export default class MessagesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { channelId } = validateMessageParamsPut.parse(req.params);

      const { attachmentSpoilers: validatedAttachmentSpoilers = [], ...body } =
        validateMessageBodyPut.parse(req.body);

      const spoilers = readAttachmentSpoilers(
        req.body,
        validatedAttachmentSpoilers,
      );

      const files: Express.Multer.File[] = Array.isArray(req.files)
        ? req.files
        : [];

      const { message, created } = await createMessage({
        ...body,
        author: req.user,
        channelId,
        files,
        spoilers,
      });

      res
        .status(created ? HttpStatusCode.Created : HttpStatusCode.Success)
        .json(message);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId, messageId } = validateMessageParamsModify.parse(
        req.params,
      );

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

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
        throw new HttpException(HttpStatusCode.NotFound, "Message not found");

      if (BigInt(message.authorId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You can only edit your own messages",
        );

      const { content } = validateMessageBodyPatch.parse(req.body);

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

      const effectiveCanEmbed = !channel.spaceId || canEmbed;

      const sanitizedContent = content
        ? await sanitizeContent(content, channel, user.id, canUseExternalEmojis)
        : content;

      const result = await execNormalized<APIMessage>(
        db
          .update(messagesTable)
          .set({
            content: sanitizedContent,
            embeds: effectiveCanEmbed
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

      const [newMessage] = await hydrateMessagesForResponse(
        [
          {
            ...result,
            channel,
            author: await getUser(message.authorId),
            expressions: await resolveExpressions(
              result.content ?? "",
              result.expressionIds,
            ),
            expressionIds: (result.expressionIds ?? []).map((id) =>
              id.toString(),
            ),
          },
        ],
        user.id,
        false,
      );

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

      const { channelId } = validateChannelParamsGet.parse(req.params);

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.spaceId && !(await getMember(channel.spaceId, user.id, true)))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a member of this space",
        );

      if (
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM
      ) {
        if (!(await isChannelRecipient(channel.id, user.id))) {
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not part of this DMChannel",
          );
        }
      }

      if (channel.spaceId)
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ViewChannel", "ReadMessageHistory"],
        });

      const { around, before, after, limit } = messagesGetQuery.parse(
        req.query,
      );

      const nowSnowflake = BigInt(Snowflake.generate());

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

      if (messages) {
        const blockedIds = await getBlockedUserIds(user.id);
        const filtered = filterByBlockedAuthors(messages, blockedIds);
        return res
          .status(HttpStatusCode.Success)
          .json(await attachReactionsToMessages(filtered, user.id));
      }

      if (around) {
        const halfLimit = Math.floor(limit / 2);
        const afterLimit = limit - halfLimit;

        const right = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.channelId, BigInt(channelId)),
              lt(messagesTable.id, BigInt(around)),
            ),
            orderBy: desc(messagesTable.id),
            limit: halfLimit,
          }),
        );

        const left = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.channelId, BigInt(channelId)),
              gte(messagesTable.id, BigInt(around)),
            ),
            orderBy: asc(messagesTable.id),
            limit: afterLimit,
          }),
        );

        messages = [...left, ...right].sort((first, second) => {
          const firstId = BigInt(first.id);
          const secondId = BigInt(second.id);
          if (firstId === secondId) return 0;
          return firstId < secondId ? -1 : 1;
        });
      } else if (before) {
        messages = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.channelId, BigInt(channelId)),
              lt(messagesTable.id, BigInt(before)),
            ),
            orderBy: desc(messagesTable.id),
            limit,
          }),
        );
      } else if (after) {
        messages = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.channelId, BigInt(channelId)),
              gte(messagesTable.id, BigInt(after)),
            ),
            orderBy: asc(messagesTable.id),
            limit,
          }),
        );
      } else {
        messages = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
            },
            where: eq(messagesTable.channelId, BigInt(channelId)),
            orderBy: desc(messagesTable.id),
            limit,
          }),
        );
      }

      const messagesWithExpressions = await hydrateMessagesForResponse(
        messages,
        user.id,
      );

      const blockedIds = await getBlockedUserIds(user.id);
      const visibleMessages = filterByBlockedAuthors(
        messagesWithExpressions,
        blockedIds,
      );

      res.status(HttpStatusCode.Success).json(visibleMessages);

      void setCache("messages", cacheKey, visibleMessages);
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId, messageId } = validateMessageParamsModify.parse(
        req.params,
      );

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

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
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.id, BigInt(messageId)),
              eq(messagesTable.channelId, BigInt(channel.id)),
            ),
          }),
        );

      if (!message)
        throw new HttpException(HttpStatusCode.NotFound, "Message not found");

      const isAuthor = BigInt(message.authorId) === BigInt(user.id);
      const canModerate =
        Boolean(channel.spaceId) && permissions?.has("ManageMessages");

      if (!isAuthor && !canModerate)
        throw new HttpException(HttpStatusCode.Forbidden, "Missing permission");

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

  static async ack(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId, messageId } = validateMessageAckParams.parse(
        req.params,
      );

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.spaceId) {
        if (!(await getMember(channel.spaceId, user.id, true)))
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a member of this space",
          );
      } else {
        if (!(await isChannelRecipient(channel.id, user.id)))
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not part of this channel",
          );
      }

      const [updated] = await db
        .insert(readStatesTable)
        .values({
          userId: BigInt(user.id),
          channelId: BigInt(channelId),
          type: ReadStateType.Messages,
          lastMessageId: BigInt(messageId),
          notificationsCursor: BigInt(messageId),
          lastAckedId: BigInt(messageId),
          mentionCount: 0,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            readStatesTable.userId,
            readStatesTable.channelId,
            readStatesTable.type,
          ],
          set: {
            lastMessageId: BigInt(messageId),

            notificationsCursor: sql`GREATEST(read_states."notificationsCursor", EXCLUDED."notificationsCursor")`,
            lastAckedId: sql`GREATEST(read_states."lastAckedId", EXCLUDED."lastAckedId")`,

            mentionCount: sql`CASE WHEN EXCLUDED."lastAckedId" >= COALESCE(read_states."lastMentionMessageId", 0) THEN 0 ELSE read_states."mentionCount" END`,
            updatedAt: new Date(),
          },
        })
        .returning({ mentionCount: readStatesTable.mentionCount });

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:MessageAck",
          run: () =>
            emitEvent({
              event: "MessageAck",
              user_id: user.id,
              data: {
                channelId,
                lastMessageId: messageId,
                notificationCursor: messageId,
                lastAckedId: messageId,
                mentionCount: updated?.mentionCount ?? 0,
                type: ReadStateType.Messages,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async ackBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { readStates } = z
        .object({
          readStates: z
            .object({
              channelId: z.string("Invalid Channel ID"),
              lastMessageId: z.string("Invalid Last Message ID"),
              type: z
                .number("Invalid Read State Type")
                .refine(
                  (v) => v === ReadStateType.Messages,
                  "Only Messages type is supported",
                ),
            })
            .array(),
        })
        .parse(req.body);

      // Batch fetch all channels at once
      const channels = await getChannels(readStates.map((s) => s.channelId));

      // Filter out channels user doesn't have access to
      const validStates = (
        await Promise.all(
          readStates.map(async (state) => {
            const channel = channels.get(state.channelId);
            if (!channel) return null;

            if (channel.spaceId) {
              if (!(await getMember(channel.spaceId, user.id, true)))
                return null;
            } else {
              if (!(await isChannelRecipient(channel.id, user.id))) return null;
            }

            return state;
          }),
        )
      ).filter((state) => !!state);

      if (!validStates.length) {
        res.sendStatus(HttpStatusCode.NoContent);
        return;
      }

      const updatedRows = await db
        .insert(readStatesTable)
        .values(
          validStates.map((state) => ({
            userId: BigInt(user.id),
            channelId: BigInt(state.channelId),
            type: state.type,
            lastMessageId: BigInt(state.lastMessageId),
            notificationsCursor: BigInt(state.lastMessageId),
            lastAckedId: BigInt(state.lastMessageId),
            mentionCount: 0,
            updatedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [
            readStatesTable.userId,
            readStatesTable.channelId,
            readStatesTable.type,
          ],
          set: {
            lastMessageId: sql`EXCLUDED."lastMessageId"`,
            notificationsCursor: sql`GREATEST(read_states."notificationsCursor", EXCLUDED."notificationsCursor")`,
            lastAckedId: sql`GREATEST(read_states."lastAckedId", EXCLUDED."lastAckedId")`,
            mentionCount: sql`CASE WHEN EXCLUDED."lastAckedId" >= COALESCE(read_states."lastMentionMessageId", 0) THEN 0 ELSE read_states."mentionCount" END`,
            updatedAt: new Date(),
          },
        })
        .returning({
          channelId: readStatesTable.channelId,
          mentionCount: readStatesTable.mentionCount,
        });

      const mentionCountByChannel = new Map(
        updatedRows.map((r) => [r.channelId.toString(), r.mentionCount]),
      );

      const results = validStates.map((state) => ({
        channelId: state.channelId,
        lastMessageId: state.lastMessageId,
        notificationCursor: state.lastMessageId,
        lastAckedId: state.lastMessageId,
        mentionCount: mentionCountByChannel.get(state.channelId) ?? 0,
        type: ReadStateType.Messages,
      }));

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:MessageAckBulk",
          run: () =>
            emitEvent({
              event: "MessageAckBulk",
              user_id: user.id,
              data: results,
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async patchReadState(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId } = validateChannelParamsGet.parse(req.params);
      const body = patchChannelNotificationSettingsSchema.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      if (channel.spaceId) {
        if (!(await getMember(channel.spaceId, user.id, true))) {
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a member of this space",
          );
        }
      } else if (!(await isChannelRecipient(channel.id, user.id))) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not part of this channel",
        );
      }

      const existing = await db.query.readStatesTable.findFirst({
        where: and(
          eq(readStatesTable.userId, BigInt(user.id)),
          eq(readStatesTable.channelId, BigInt(channelId)),
          eq(readStatesTable.type, ReadStateType.Messages),
        ),
      });

      let mutedUntil = existing?.mutedUntil ?? null;
      if (body.muteDuration !== undefined) {
        mutedUntil = computeMutedUntilDuration(body.muteDuration);
      } else if (body.mutedUntil !== undefined) {
        mutedUntil = body.mutedUntil;
      }

      let notificationLevel = existing?.notificationLevel ?? null;
      if (body.useSpaceDefault) {
        notificationLevel = null;
      } else if (body.notificationLevel !== undefined) {
        notificationLevel = body.notificationLevel;
      }

      let muted = existing
        ? BitField.fromBits(readStateFlags, existing.flags ?? 0n).has("Muted")
        : false;

      if (body.muted !== undefined) {
        muted = body.muted;
      } else if (
        body.muteDuration !== undefined ||
        body.mutedUntil !== undefined
      ) {
        muted =
          mutedUntil != null && new Date(mutedUntil).getTime() > Date.now();
      } else if (body.notificationLevel === NotificationLevel.Nothing) {
        muted = true;
      } else if (
        body.notificationLevel !== undefined &&
        body.notificationLevel !== NotificationLevel.Nothing
      ) {
        muted = false;
      } else if (body.useSpaceDefault) {
        muted = false;
      }

      const flags = BitField.fromBits(
        readStateFlags,
        existing?.flags ?? 0n,
      ).set("Muted", muted);

      const conflictSet: {
        flags: bigint;
        updatedAt: Date;
        notificationLevel?: number | null;
        mutedUntil?: Date | null;
      } = {
        flags: flags.toBigInt(),
        updatedAt: new Date(),
      };

      if (body.useSpaceDefault || body.notificationLevel !== undefined) {
        conflictSet.notificationLevel = notificationLevel;
      }
      if (body.muteDuration !== undefined || body.mutedUntil !== undefined) {
        conflictSet.mutedUntil = mutedUntil;
      }

      const [row] = await db
        .insert(readStatesTable)
        .values({
          userId: BigInt(user.id),
          channelId: BigInt(channelId),
          type: ReadStateType.Messages,
          flags: flags.toBigInt(),
          notificationLevel,
          mutedUntil,
        })
        .onConflictDoUpdate({
          target: [
            readStatesTable.userId,
            readStatesTable.channelId,
            readStatesTable.type,
          ],
          set: conflictSet,
        })
        .returning();

      const result = serializeReadState(row);

      fireAndForgetAll([
        {
          label: "event:ReadStateUpdate",
          run: () =>
            emitEvent({
              event: "ReadStateUpdate",
              user_id: user.id,
              data: result,
            }),
        },
      ]);

      res.status(HttpStatusCode.Success).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async pin(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateMessageParamsModify.parse(
        req.params,
      );

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      if (channel.spaceId) {
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["PinMessages"],
        });
      }

      const message = await db.query.messagesTable.findFirst({
        where: and(
          eq(messagesTable.id, BigInt(messageId)),
          eq(messagesTable.channelId, BigInt(channelId)),
        ),
      });

      if (!message) {
        throw new HttpException(HttpStatusCode.NotFound, "Message not found");
      }

      if (!channel.spaceId && message.authorId?.toString() !== user.id) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Missing permissions",
        );
      }

      if (message.pinned) {
        res.status(HttpStatusCode.NoContent).send();
        return;
      }

      await db
        .update(messagesTable)
        .set({
          pinned: true,
          pinnedAt: new Date(),
          pinnedBy: BigInt(user.id),
        })
        .where(eq(messagesTable.id, BigInt(messageId)));

      res.status(HttpStatusCode.NoContent).send();

      fireAndForgetAll([
        {
          label: "event:MessageUpdate:pinned",
          run: async () => {
            const updated = await execNormalized<APIMessage>(
              db.query.messagesTable.findFirst({
                where: eq(messagesTable.id, BigInt(messageId)),
                with: {
                  author: {
                    columns: publicUserColumns,
                  },
                },
              }),
            );

            if (!updated) return;

            const [hydrated] = await hydrateMessagesForResponse(
              [{ ...updated, channel }],
              user.id,
            );

            await emitEvent({
              event: "MessageUpdate",
              channel_id: channel.id,
              data: hydrated,
            });
          },
        },
        {
          label: "event:MessageCreate:channelPinned",
          run: async () => {
            const noticeId = BigInt(Snowflake.generate());

            const inserted = await execNormalized<APIMessage>(
              db
                .insert(messagesTable)
                .values({
                  id: noticeId,
                  type: MessageType.ChannelPinned,
                  authorId: BigInt(user.id),
                  channelId: BigInt(channelId),
                  spaceId: channel.spaceId
                    ? BigInt(channel.spaceId)
                    : undefined,
                  content: messageId,
                })
                .returning()
                .then((rows) => rows[0]),
            );

            if (!inserted) return;

            const [hydrated] = await hydrateMessagesForResponse(
              [
                {
                  ...inserted,
                  channel,
                  author: user,
                },
              ],
              user.id,
            );

            await emitEvent({
              event: "MessageCreate",
              channel_id: channel.id,
              data: hydrated,
            });

            await setChannelLastMessageId(channel.id, hydrated.id);
          },
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

  static async unpin(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateMessageParamsModify.parse(
        req.params,
      );

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      if (channel.spaceId) {
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["PinMessages"],
        });
      }

      const message = await db.query.messagesTable.findFirst({
        where: and(
          eq(messagesTable.id, BigInt(messageId)),
          eq(messagesTable.channelId, BigInt(channelId)),
        ),
      });

      if (!message) {
        throw new HttpException(HttpStatusCode.NotFound, "Message not found");
      }

      if (!message.pinned) {
        res.status(HttpStatusCode.NoContent).send();
        return;
      }

      await db
        .update(messagesTable)
        .set({
          pinned: false,
          pinnedAt: null,
          pinnedBy: null,
        })
        .where(
          and(
            eq(messagesTable.id, BigInt(messageId)),
            eq(messagesTable.channelId, BigInt(channelId)),
          ),
        );

      res.status(HttpStatusCode.NoContent).send();

      fireAndForgetAll([
        {
          label: "event:MessageUpdate:unpinned",
          run: async () => {
            const updated = await execNormalized<APIMessage>(
              db.query.messagesTable.findFirst({
                where: eq(messagesTable.id, BigInt(messageId)),
                with: {
                  author: {
                    columns: publicUserColumns,
                  },
                },
              }),
            );

            if (!updated) return;

            const [hydrated] = await hydrateMessagesForResponse(
              [{ ...updated, channel }],
              user.id,
            );

            await emitEvent({
              event: "MessageUpdate",
              channel_id: channel.id,
              data: hydrated,
            });
          },
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

  static async getPinned(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId } = validateChannelParamsGet.parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      if (channel.spaceId) {
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ViewChannel"],
        });
      }

      const rows = await execNormalizedMany<APIMessage>(
        db.query.messagesTable.findMany({
          where: and(
            eq(messagesTable.channelId, BigInt(channelId)),
            eq(messagesTable.pinned, true),
          ),
          orderBy: asc(messagesTable.pinnedAt),
          with: {
            author: {
              columns: publicUserColumns,
            },
            pinnedByUser: {
              columns: publicUserColumns,
            },
          },
        }),
      );

      const hydrated = await hydrateMessagesForResponse(rows, user.id);
      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async search(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId } = validateChannelParamsGet.parse(req.params);
      const query = messageSearchQuerySchema.parse(req.query.q);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      if (channel.spaceId) {
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ViewChannel"],
        });
      }

      if (
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM
      ) {
        if (!(await isChannelRecipient(channel.id, user.id))) {
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not part of this DMChannel",
          );
        }
      }

      const whereConditions = await buildMessageSearchWhere(query, {
        currentUserId: user.id,
        channelId: BigInt(channelId),
        allowChannelFilter: false,
      });
      const where = combineMessageSearchWhere(whereConditions);

      const rows = await execNormalizedMany<APIMessage>(
        db.query.messagesTable.findMany({
          where,
          orderBy: desc(messagesTable.id),
          limit: 25,
          with: {
            author: {
              columns: publicUserColumns,
            },
          },
        }),
      );

      const hydrated = await hydrateMessagesForResponse(rows, user.id);
      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async searchSpace(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = validateSpaceGetOneParams.parse(req.params);
      const query = messageSearchQuerySchema.parse(req.query.q);

      const space = await getSpaceHydrated(spaceId);
      if (!space) {
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");
      }

      const member = await getMember(space.id, user.id, true);
      if (!member) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a member of this space",
        );
      }

      const visibleChannels = filterVisibleChannelsForUser(
        space,
        BigInt(user.id),
        (await getMemberRoles(space.id, user.id)).map((role) =>
          String(role.id),
        ),
      );
      const textChannels = visibleChannels.filter(
        (channel) => channel.type === ChannelType.Text,
      );
      const textChannelIds = textChannels.map((channel) => BigInt(channel.id));

      if (textChannelIds.length === 0) {
        res.status(HttpStatusCode.Success).json([]);
        return;
      }

      const whereConditions = await buildMessageSearchWhere(query, {
        currentUserId: user.id,
        channelIds: textChannelIds,
        visibleChannels: textChannels,
        allowChannelFilter: true,
      });
      const where = combineMessageSearchWhere(whereConditions);

      const rows = await execNormalizedMany<APIMessage>(
        db.query.messagesTable.findMany({
          where,
          orderBy: desc(messagesTable.id),
          limit: 50,
          with: {
            author: {
              columns: publicUserColumns,
            },
            channel: {
              with: {
                parent: true,
              },
            },
          },
        }),
      );

      const hydrated = await hydrateMessagesForResponse(rows, user.id);
      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }
}
