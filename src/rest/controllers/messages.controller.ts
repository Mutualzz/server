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
  postsTable,
  relationshipsTable,
  spaceMembersTable,
} from "@mutualzz/database";
import {
  type APIAttachment,
  type APIMessage,
  type APIMessageEmbed,
  type APIPost,
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
  attachHashtagsToPosts,
  buildEmbeds,
  bucketName,
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
  publicUserColumns,
  requireChannelPermissions,
  requireNotRestricted,
  resolveExpressions,
  attachReactionsToMessages,
  hydrateMessagesForResponse,
  s3Client,
  sanitizeContent,
  sendMessagePushNotifications,
  setChannelLastMessageId,
  Snowflake,
  validateMessageStickers,
} from "@mutualzz/util";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  validateChannelParamsGet,
  validateMessageAckParams,
  validateMessageBodyPatch,
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
import { createSystemMessage } from "@mutualzz/util/systemUser";
import {
  contentHasInviteLinks,
  resolveMessageCodedLinks,
} from "../../util/codedLinks";
import { readStatesTable } from "@mutualzz/database/schemas/ReadState";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { unavailableLike } from "@mutualzz/gateway/util/Calculations";
import { z } from "zod";

export default class MessagesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      requireNotRestricted(user);

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

      const {
        content,
        nonce,
        repliedToId,
        mentionReply = true,
        expressionIds = [],
        sharedPostId,
        codedLinks = [],
      } = validateMessageBodyPut.parse(req.body);

      const uploadedFiles: Express.Multer.File[] = Array.isArray(req.files)
        ? req.files
        : [];

      if (
        !content &&
        expressionIds.length === 0 &&
        uploadedFiles.length === 0 &&
        !sharedPostId &&
        codedLinks.length === 0 &&
        !contentHasInviteLinks(content)
      )
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Message must have content, stickers, or attachments",
        );

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

      if (channel.spaceId && uploadedFiles.length > 0)
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["AttachFiles"],
        });

      if (nonce) {
        let existingMessage = await getCache("message", nonce);
        if (existingMessage)
          return res.status(HttpStatusCode.Success).json(existingMessage);

        existingMessage = await execNormalized<APIMessage>(
          db.query.messagesTable.findFirst({
            with: {
              channel: true,
              repliedTo: true,
            },
            where: and(
              eq(messagesTable.nonce, BigInt(nonce)),
              eq(messagesTable.channelId, BigInt(channel.id)),
              eq(messagesTable.authorId, BigInt(user.id)),
            ),
          }),
        );

        if (existingMessage) {
          const [hydrated] = await hydrateMessagesForResponse(
            [
              {
                ...existingMessage,
                expressions: await resolveExpressions(
                  existingMessage.content ?? "",
                  existingMessage.expressionIds,
                ),
                expressionIds: (existingMessage.expressionIds ?? []).map((id) =>
                  id.toString(),
                ),
              },
            ],
            user.id,
            false,
          );
          await setCache("message", nonce, hydrated);
          return res.status(HttpStatusCode.Success).json(hydrated);
        }
      }

      let canUseExternalEmojis = false;
      let canEmbed = false;
      let canUseExternalStickers = false;
      let canMentionEveryone = false;

      if (channel.spaceId) {
        try {
          const { permissions } = await requireChannelPermissions({
            channelId: channel.id,
            userId: user.id,
            needed: ["UseExternalStickers"],
            mode: "Any",
          });
          canUseExternalStickers = permissions.has("UseExternalStickers");
        } catch {
          canUseExternalStickers = false;
        }
      } else canUseExternalStickers = true;

      const validatedStickerIds = await validateMessageStickers({
        expressionIds,
        channel,
        userId: user.id,
        canUseExternalStickers,
      });

      if (channel.spaceId) {
        try {
          const { permissions } = await requireChannelPermissions({
            channelId: channel.id,
            userId: user.id,
            needed: ["UseExternalEmojis", "EmbedLinks", "MentionEveryone"],
            mode: "Any",
          });

          canUseExternalEmojis = permissions.has("UseExternalEmojis");
          canEmbed = permissions.has("EmbedLinks");
          canMentionEveryone = permissions.has("MentionEveryone");
        } catch {
          canUseExternalEmojis = false;
          canEmbed = false;
          canMentionEveryone = false;
        }
      }

      const effectiveCanEmbed = !channel.spaceId || canEmbed;

      const sanitizedContent = content
        ? await sanitizeContent(content, channel, user.id, canUseExternalEmojis)
        : null;

      if (channel.type === ChannelType.DM) {
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
            const theirBlockOfMe = await execNormalized<APIRelationship>(
              db.query.relationshipsTable.findFirst({
                where: and(
                  eq(relationshipsTable.userId, BigInt(otherId)),
                  eq(relationshipsTable.otherUserId, BigInt(user.id)),
                  eq(relationshipsTable.type, RelationshipType.Blocked),
                ),
              }),
            );

            const myBlockOfThem = await execNormalized<APIRelationship>(
              db.query.relationshipsTable.findFirst({
                where: and(
                  eq(relationshipsTable.userId, BigInt(user.id)),
                  eq(relationshipsTable.otherUserId, BigInt(otherId)),
                  eq(relationshipsTable.type, RelationshipType.Blocked),
                ),
              }),
            );

            if (theirBlockOfMe || myBlockOfThem) {
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

      const messageId = BigInt(Snowflake.generate());

      const allUploaded: APIAttachment[] = await Promise.all(
        uploadedFiles.map(async (file) => {
          const attachmentId = Snowflake.generate();
          const originalName =
            typeof file.originalname === "string"
              ? file.originalname.trim()
              : "";
          const fallbackExt =
            file.mimetype.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ||
            "bin";
          const safeName = (
            originalName || `attachment.${fallbackExt}`
          ).replace(/[^a-zA-Z0-9._-]/g, "_");
          const key = `attachments/${messageId}/${attachmentId}_${safeName}`;

          await s3Client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Body: file.buffer,
              Key: key,
              ContentType: file.mimetype,
            }),
          );

          let width: number | undefined;
          let height: number | undefined;
          if (file.mimetype.startsWith("image/")) {
            try {
              const meta = await sharp(file.buffer).metadata();
              width = meta.width;
              height = meta.height;
            } catch {
              // ignore dimension errors
            }
          }

          const cdnBase = process.env.CDN_URL ?? "";
          return {
            id: attachmentId,
            filename: originalName || `attachment.${fallbackExt}`,
            size: file.size,
            contentType: file.mimetype,
            url: `${cdnBase}/attachments/${messageId}/${attachmentId}_${safeName}`,
            width,
            height,
          } satisfies APIAttachment;
        }),
      );

      // GIF uploads become gifv embeds so they work with the gif picker
      const attachments = allUploaded.filter(
        (a) => a.contentType !== "image/gif",
      );
      const gifEmbeds: APIMessageEmbed[] = allUploaded
        .filter((a) => a.contentType === "image/gif")
        .map((gif) => ({
          type: "gifv",
          url: gif.url,
          media: gif.url,
          image: gif.url,
          title: gif.filename,
        }));

      const { codedLinks: hydratedCodedLinks, content: messageContent } =
        await resolveMessageCodedLinks(sanitizedContent, codedLinks);

      const contentEmbeds = effectiveCanEmbed
        ? await buildEmbeds(messageContent || "")
        : [];

      const postEmbeds: APIMessageEmbed[] = [];
      if (sharedPostId) {
        const sharedPost = await execNormalized<APIPost>(
          db.query.postsTable.findFirst({
            with: { author: { columns: publicUserColumns } },
            where: eq(postsTable.id, BigInt(sharedPostId)),
          }),
        );

        if (sharedPost) {
          const [hydratedSharedPost] = await attachHashtagsToPosts([
            sharedPost,
          ]);

          postEmbeds.push({
            type: "post",
            post: {
              id: hydratedSharedPost.id,
              authorId: hydratedSharedPost.authorId,
              author: hydratedSharedPost.author,
              content: hydratedSharedPost.content,
              attachments: hydratedSharedPost.attachments,
              hashtags: hydratedSharedPost.hashtags,
              createdAt: hydratedSharedPost.createdAt,
            },
          });
        }
      }

      const embeds = [...contentEmbeds, ...gifEmbeds, ...postEmbeds];

      const newMessage = await execNormalized<APIMessage>(
        db
          .insert(messagesTable)
          .values({
            id: messageId,
            authorId: BigInt(user.id),
            nonce: nonce ? BigInt(nonce) : undefined,
            channelId: BigInt(channel.id),
            spaceId: channel.spaceId ? BigInt(channel.spaceId) : undefined,
            content: messageContent,
            embeds,
            codedLinks: hydratedCodedLinks,
            attachments,
            repliedToId: repliedToId ? BigInt(repliedToId) : undefined,
            expressionIds: validatedStickerIds,
            type: repliedToId ? MessageType.Reply : MessageType.Default,
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
        canMentionEveryone && sanitizedContent?.includes("@everyone")
          ? [{ type: "everyone", id: "0" }]
          : [];
      const hereMentions: { type: MentionType; id: string }[] =
        canMentionEveryone && sanitizedContent?.includes("@here")
          ? [{ type: "here", id: "0" }]
          : [];

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

      let repliedTo: APIMessage | null = null;
      if (repliedToId)
        repliedTo = await execNormalized<APIMessage>(
          db.query.messagesTable.findFirst({
            where: eq(messagesTable.id, BigInt(repliedToId)),
          }),
        );

      if (mentionReply && repliedTo && repliedTo.authorId !== user.id) {
        const replyAuthorMention = {
          type: "user" as MentionType,
          id: repliedTo.authorId.toString(),
        };
        if (
          !uniqueMentions.some(
            (m) => m.type === "user" && m.id === replyAuthorMention.id,
          )
        ) {
          uniqueMentions.push(replyAuthorMention);
        }
      }

      const message = {
        ...newMessage,
        mentions: uniqueMentions,
        channel: channel,
        author: user,
        space: channel.spaceId ? await getSpace(channel.spaceId) : null,
        expressions: await resolveExpressions(
          newMessage.content ?? "",
          newMessage.expressionIds,
        ),
        expressionIds: (newMessage.expressionIds ?? []).map((id) =>
          id.toString(),
        ),
        attachments,
        reactions: [],
        repliedTo,
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
          label: "channel:lastMessageId",
          run: () => setChannelLastMessageId(channel.id, message.id),
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
                  return !unavailableLike(p ?? null);
                });

                membersToNotify.push(...onlineMemberIds);
              }

              const uniqueMembers = Array.from(new Set(membersToNotify));

              if (uniqueMembers.length > 0 || roleMentionIds.length > 0) {
                await incrementMentionCounts(
                  channel.id,
                  uniqueMembers,
                  roleMentionIds,
                  newMessage.id,
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
              lastMessageId: message.id,
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
        {
          label: "push:message",
          run: () =>
            sendMessagePushNotifications({
              message,
              channel: {
                id: channel.id,
                type: channel.type,
                spaceId: channel.spaceId,
              },
              authorId: user.id,
              authorName: user.globalName ?? user.username,
              authorAvatar: {
                id: user.id,
                avatar: user.avatar,
                defaultAvatar: user.defaultAvatar,
              },
              userMentionIds: userMentionMatches.map((mention) =>
                mention.id.toString(),
              ),
              roleMentionIds: roleMentionMatches.map((mention) =>
                mention.id.toString(),
              ),
              everyoneMentioned: everyoneMentions.length > 0,
              hereMentioned: hereMentions.length > 0,
            }),
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

      if (messages) {
        return res
          .status(HttpStatusCode.Success)
          .json(await attachReactionsToMessages(messages, user.id));
      }

      if (around) {
        const right = await execNormalizedMany<APIMessage>(
          db.query.messagesTable.findMany({
            with: {
              channel: true,
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
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
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
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
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
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
              author: {
                columns: publicUserColumns,
              },
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
              author: {
                columns: publicUserColumns,
              },
              repliedTo: true,
              space: true,
            },
            where: eq(messagesTable.channelId, BigInt(channelId)),
            orderBy: desc(messagesTable.createdAt),
            limit,
          }),
        );
      }

      const messagesWithExpressions = await hydrateMessagesForResponse(
        messages,
        user.id,
      );

      res.status(HttpStatusCode.Success).json(messagesWithExpressions);

      void setCache("messages", cacheKey, messagesWithExpressions);
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
}
