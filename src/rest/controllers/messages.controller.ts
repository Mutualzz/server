import {
  deleteCache,
  getCache,
  invalidateCache,
  setCache,
} from "@mutualzz/cache";
import {
  channelRecipientsTable,
  db,
  messagesTable,
  relationshipsTable,
  spaceMembersTable,
} from "@mutualzz/database";
import {
  type APIMessage,
  type APIRelationship,
  ChannelType,
  HttpException,
  HttpStatusCode,
  type MentionType,
  MessageType,
  ReadStateType,
  RelationshipType,
} from "@mutualzz/types";
import {
  buildEmbeds,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  getChannel,
  getChannels,
  getMember,
  getSpace,
  getUser,
  incrementMentionCounts,
  isChannelRecipient,
  requireChannelPermissions,
  sanitizeContent,
  Snowflake,
} from "@mutualzz/util";
import {
  validateChannelParamsGet,
  validateMessageAckParams,
  validateMessageBodyPut,
  validateMessageParamsModify,
  validateMessageParamsPut,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  type BitField,
  messageFlags,
  type PermissionFlags,
} from "@mutualzz/bitfield";
import { createSystemMessage } from "@mutualzz/util/systemUser.ts";
import { readStatesTable } from "@mutualzz/database/schemas/ReadState";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service.ts";
import { offlineLike } from "@mutualzz/gateway/util/Calculations.ts";
import { z } from "zod";

export default class MessagesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      const { channelId } = validateMessageParamsPut.parse(req.params);

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

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
          if (!(await isChannelRecipient(channel.id, user.id))) {
            throw new HttpException(
              HttpStatusCode.Forbidden,
              "You are not part of this DM Channel",
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
          return res.status(HttpStatusCode.Success).json(existingMessage);

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
          return res.status(HttpStatusCode.Success).json(existingMessage);
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

      if (
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM
      ) {
        const recipientRows = await execNormalizedMany(
          db.query.channelRecipientsTable.findMany({
            where: eq(channelRecipientsTable.channelId, BigInt(channel.id)),
          }),
        );

        const otherRecipients = recipientRows
          .map((r) => r.userId)
          .filter((id: string) => id !== user.id);

        const enforceBlockCheck = otherRecipients.length === 1;

        if (enforceBlockCheck) {
          for (const otherId of otherRecipients) {
            const canonicalUserId =
              BigInt(user.id) < BigInt(otherId) ? user.id : otherId;
            const canonicalOtherId =
              BigInt(user.id) < BigInt(otherId) ? otherId : user.id;

            const existingRel = await execNormalized<APIRelationship>(
              db.query.relationshipsTable.findFirst({
                where: and(
                  eq(relationshipsTable.userId, BigInt(canonicalUserId)),
                  eq(relationshipsTable.otherUserId, BigInt(canonicalOtherId)),
                ),
              }),
            );

            if (
              existingRel &&
              existingRel.type === RelationshipType.Blocked &&
              existingRel.userId.toString() === otherId.toString()
            ) {
              const sysMsg = await createSystemMessage(
                channelId,
                "You cannot message this person",
                messageFlags.Ephemeral,
              );

              fireAndForgetAll([
                {
                  label: `event:MessageCreate:ephemeral:${user.id}`,
                  run: () =>
                    emitEvent({
                      event: "MessageCreate",
                      user_id: user.id,
                      data: sysMsg,
                    }),
                },
              ]);

              throw new HttpException(
                HttpStatusCode.Forbidden,
                "You cannot message this person",
              );
            }
          }
        }
      }

      const newMessage = await execNormalized<APIMessage>(
        db
          .insert(messagesTable)
          .values({
            id: BigInt(Snowflake.generate()),
            authorId: BigInt(user.id),
            nonce: nonce ? BigInt(nonce) : undefined,
            channelId: BigInt(channel.id),
            spaceId: channel.spaceId ? BigInt(channel.spaceId) : undefined,
            content: sanitizedContent,
            embeds: canEmbed ? await buildEmbeds(sanitizedContent || "") : [],
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

      const userMentionMatches: { type: MentionType; id: string }[] = (
        sanitizedContent?.match(/<@(\d+)>/g) ?? []
      )
        .map((m) => m.replace(/<@|>/g, ""))
        .filter((id) => id !== user.id)
        .map((id) => ({
          type: "user",
          id: id,
        }));

      const roleMentionMatches: { type: MentionType; id: string }[] = (
        sanitizedContent?.match(/<@&(\d+)>/g) ?? []
      )
        .map((m) => m.replace(/<@&|>/g, ""))
        .filter((id) => id !== user.id)
        .map((id) => ({
          type: "role",
          id: id,
        }));

      const everyoneMentions: { type: MentionType; id: string }[] =
        sanitizedContent?.includes("@everyone")
          ? [{ type: "everyone", id: "0" }]
          : [];
      const hereMentions: { type: MentionType; id: string }[] =
        sanitizedContent?.includes("@here") ? [{ type: "here", id: "0" }] : [];

      const uniqueMentions = [
        ...new Map(
          [
            ...userMentionMatches,
            ...roleMentionMatches,
            ...everyoneMentions,
            ...hereMentions,
          ].map((m) => [`${m.type}:${m.id.toString()}`, m]),
        ).values(),
      ];

      const message = {
        ...newMessage,
        mentions: uniqueMentions,
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
          label: "readState:mentions",
          run: async () => {
            if (uniqueMentions.length > 0) {
              await db
                .update(messagesTable)
                .set({ mentions: uniqueMentions })
                .where(eq(messagesTable.id, BigInt(newMessage.id)));

              const userMentionIds = userMentionMatches.map((m) =>
                m.id.toString(),
              );
              const roleMentionIds = roleMentionMatches.map((m) =>
                m.id.toString(),
              );

              const membersToNotify = [...userMentionIds];

              if (everyoneMentions.length > 0 && channel.spaceId) {
                const allMembers = await db
                  .select({
                    userId: spaceMembersTable.userId,
                  })
                  .from(spaceMembersTable)
                  .where(
                    eq(spaceMembersTable.spaceId, BigInt(channel.spaceId)),
                  );
                membersToNotify.push(
                  ...allMembers
                    .map((m) => m.userId.toString())
                    .filter((id) => id !== user.id),
                );
              }

              if (hereMentions.length > 0 && channel.spaceId) {
                const allMembers = await db
                  .select({
                    userId: spaceMembersTable.userId,
                  })
                  .from(spaceMembersTable)
                  .where(
                    eq(spaceMembersTable.spaceId, BigInt(channel.spaceId)),
                  );

                const memberIds = allMembers
                  .map((m) => m.userId.toString())
                  .filter((id) => id !== user.id);

                const presences = await Promise.all(
                  memberIds.map((id) => PresenceService.get(id)),
                );

                const onlineMemberIds = memberIds.filter((_, idx) => {
                  const p = presences[idx];
                  return !offlineLike(p ?? null);
                });

                membersToNotify.push(...onlineMemberIds);
              }

              const uniqueMembers = Array.from(new Set(membersToNotify));

              if (uniqueMembers.length > 0 || roleMentionIds.length > 0) {
                await incrementMentionCounts(
                  channel.id,
                  uniqueMembers,
                  roleMentionIds,
                );
              }
            }
          },
        },
        {
          label: "event:ChannelUpdate",
          run: () => {
            const updatedChannel = {
              ...channel,
              lastMessage: message,
            };

            emitEvent({
              event: "ChannelUpdate",
              channel_id: channel.id,
              data: updatedChannel,
            });
          },
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

      if (
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM
      ) {
        const closedRecipients = await db
          .select()
          .from(channelRecipientsTable)
          .where(
            and(
              eq(channelRecipientsTable.channelId, BigInt(channel.id)),
              eq(channelRecipientsTable.closed, true),
              ne(channelRecipientsTable.userId, BigInt(user.id)),
            ),
          );

        if (closedRecipients.length > 0) {
          await db
            .update(channelRecipientsTable)
            .set({ closed: false })
            .where(
              and(
                eq(channelRecipientsTable.channelId, BigInt(channel.id)),
                eq(channelRecipientsTable.closed, true),
                ne(channelRecipientsTable.userId, BigInt(user.id)),
              ),
            );

          fireAndForgetAll(
            closedRecipients.map((r) => ({
              label: `event:ChannelCreate:${r.userId}`,
              run: () => {
                emitEvent({
                  event: "ChannelCreate",
                  user_id: r.userId.toString(),
                  data: channel,
                });
              },
            })),
          );
        }
      }
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

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
            embeds: canEmbed ? await buildEmbeds(sanitizedContent || "") : [],
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
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

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

      const aroundRaw = req.query.around ? `${req.query.around}` : undefined;
      const beforeRaw = req.query.before ? `${req.query.before}` : undefined;
      const afterRaw = req.query.after ? `${req.query.after}` : undefined;

      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));

      const nowSnowflake = BigInt(Snowflake.generate());
      const parseSnow = (v?: string) => (v ? BigInt(v).toString() : undefined);

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

      if (messages) return res.status(HttpStatusCode.Success).json(messages);

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
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
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
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

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
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

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

      await db
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

            mentionCount: 0,
            updatedAt: new Date(),
          },
        });

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
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

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

      await db
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
            mentionCount: 0,
            updatedAt: new Date(),
          },
        });

      const results = validStates.map((state) => ({
        channelId: state.channelId,
        lastMessageId: state.lastMessageId,
        notificationCursor: state.lastMessageId,
        lastAckedId: state.lastMessageId,
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
}
