import { getCache, invalidateCache, setCache } from "@mutualzz/cache";
import {
  channelRecipientsTable,
  db,
  messagesTable,
  postsTable,
  spaceMembersTable,
  spaceMemberRolesTable,
  messageMentionsTable,
} from "@mutualzz/database";
import {
  type APIAttachment,
  type APIMessage,
  type APIMessageEmbed,
  type APIPost,
  type APIPrivateUser,
  ChannelType,
  HttpException,
  HttpStatusCode,
  type MentionType,
  MessageType,
  shouldIncrementMentionCount,
} from "@mutualzz/types";
import {
  attachHashtagsToPosts,
  buildEmbeds,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  getChannel,
  getMember,
  getSpace,
  incrementMentionCounts,
  isChannelRecipient,
  publicUserColumns,
  requireChannelPermissions,
  requireNotRestricted,
  resolveExpressions,
  hydrateMessagesForResponse,
  sanitizeContent,
  sendMessagePushNotifications,
  setChannelLastMessageId,
  Snowflake,
  validateMessageStickers,
  resolveChannelNotificationForUser,
} from "@mutualzz/util";
import { type validateMessageBodyPut } from "@mutualzz/validators";
import { and, eq, ne, sql } from "drizzle-orm";
import { messageFlags } from "@mutualzz/bitfield";
import { createSystemMessage } from "@mutualzz/util/systemUser";
import { isBlockedBetween } from "@mutualzz/util/blocks.ts";
import { assertCanDm } from "@mutualzz/util/privacy.ts";
import {
  contentHasInviteLinks,
  resolveMessageCodedLinks,
} from "../codedLinks.ts";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { unavailableLike } from "@mutualzz/gateway/util/Calculations";
import { type z } from "zod";
import { uploadMessageAttachments } from "./attachments.ts";

type MessageBody = z.infer<typeof validateMessageBodyPut>;

export interface CreateMessageInput extends Pick<
  MessageBody,
  | "content"
  | "nonce"
  | "repliedToId"
  | "mentionReply"
  | "expressionIds"
  | "sharedPostId"
  | "codedLinks"
> {
  author: APIPrivateUser;
  channelId: string;
  files?: Express.Multer.File[];
  spoilers?: boolean[];
  preparedAttachments?: APIAttachment[];
}

const MAX_POSTGRES_BIGINT = 9223372036854775807n;

export async function createMessage(input: CreateMessageInput) {
  const user = input.author;
  const { channelId } = input;

  requireNotRestricted(user);

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
  } = input;

  const rawSpoilers = input.spoilers ?? [];
  const uploadedFiles = input.files ?? [];
  const preparedAttachments = input.preparedAttachments ?? [];
  const attachmentCount = uploadedFiles.length + preparedAttachments.length;

  if (
    !content &&
    expressionIds.length === 0 &&
    attachmentCount === 0 &&
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
      if (channel.spaceId && !(await getMember(channel.spaceId, user.id, true)))
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

  if (channel.spaceId && attachmentCount > 0)
    await requireChannelPermissions({
      channelId: channel.id,
      userId: user.id,
      needed: ["AttachFiles"],
    });

  if (nonce) {
    let existingMessage = await getCache("message", nonce);
    if (existingMessage) return { message: existingMessage, created: false };

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
      return { message: hydrated, created: false };
    }
  }

  let canUseExternalEmojis = false;
  let canEmbed = false;
  let canUseExternalStickers: boolean;
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

  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
    const recipientRows = await execNormalizedMany(
      db.query.channelRecipientsTable.findMany({
        where: eq(channelRecipientsTable.channelId, BigInt(channel.id)),
      }),
    );

    const otherRecipients = recipientRows
      .map((r) => r.userId)
      .filter((id: string) => id !== user.id);

    for (const otherId of otherRecipients) {
      if (await isBlockedBetween(user.id, otherId)) {
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

      if (channel.type === ChannelType.DM && otherRecipients.length === 1) {
        await assertCanDm(otherId, user.id);
      }
    }
  }

  const messageId = BigInt(Snowflake.generate());

  const allUploaded: APIAttachment[] =
    preparedAttachments.length > 0
      ? preparedAttachments
      : await uploadMessageAttachments(
          messageId.toString(),
          uploadedFiles,
          rawSpoilers,
        );

  // GIF uploads become gifv embeds so they work with the gif picker
  const attachments = allUploaded.filter((a) => a.contentType !== "image/gif");
  const gifEmbeds: APIMessageEmbed[] = allUploaded
    .filter((a) => a.contentType === "image/gif")
    .map((gif) => ({
      type: "gifv",
      url: gif.url,
      media: gif.url,
      image: gif.url,
      title: gif.filename,
      spoiler: gif.spoiler,
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
      const [hydratedSharedPost] = await attachHashtagsToPosts([sharedPost]);

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
        where: and(
          eq(messagesTable.id, BigInt(repliedToId)),
          eq(messagesTable.channelId, BigInt(channelId)),
        ),
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
    expressionIds: (newMessage.expressionIds ?? []).map((id) => id.toString()),
    attachments,
    reactions: [],
    repliedTo,
  };

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
          const mentionContext = {
            messageId: BigInt(newMessage.id),
            channelId: BigInt(channel.id),
            spaceId: channel.spaceId ? BigInt(channel.spaceId) : null,
            authorId: BigInt(user.id),
          };

          const mentionRows = uniqueMentions.flatMap(
            (mention): (typeof messageMentionsTable.$inferInsert)[] => {
              if (mention.type === "here") return [];

              if (mention.type === "everyone") {
                if (!channel.spaceId) return [];
                return [
                  {
                    ...mentionContext,
                    targetId: BigInt(channel.spaceId),
                    type: mention.type,
                  },
                ];
              }

              const targetId = BigInt(mention.id);
              if (targetId > MAX_POSTGRES_BIGINT) return [];
              return [{ ...mentionContext, targetId, type: mention.type }];
            },
          );

          await db.transaction(async (transaction) => {
            await transaction
              .update(messagesTable)
              .set({ mentions: uniqueMentions })
              .where(eq(messagesTable.id, BigInt(newMessage.id)));

            if (mentionRows.length > 0)
              await transaction
                .insert(messageMentionsTable)
                .values(mentionRows)
                .onConflictDoNothing();
          });

          const userMentionIds = userMentionMatches.map((m) => m.id.toString());
          const roleMentionIds = roleMentionMatches.map((m) => m.id.toString());

          const membersToNotify = [...userMentionIds];

          if (everyoneMentions.length > 0 && channel.spaceId) {
            const allMembers = await db
              .select({
                userId: spaceMembersTable.userId,
              })
              .from(spaceMembersTable)
              .where(eq(spaceMembersTable.spaceId, BigInt(channel.spaceId)));

            const viewableMemberIds = (
              await Promise.all(
                allMembers.map(async (m) => {
                  const id = m.userId.toString();
                  if (id === user.id) return null;
                  try {
                    await requireChannelPermissions({
                      channelId: channel.id,
                      userId: id,
                      needed: ["ViewChannel"],
                    });
                    return id;
                  } catch {
                    return null;
                  }
                }),
              )
            ).filter((id): id is string => id != null);

            membersToNotify.push(...viewableMemberIds);
          }

          if (hereMentions.length > 0 && channel.spaceId) {
            const allMembers = await db
              .select({
                userId: spaceMembersTable.userId,
              })
              .from(spaceMembersTable)
              .where(eq(spaceMembersTable.spaceId, BigInt(channel.spaceId)));

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
          const directMentionIds = new Set(userMentionIds);
          let roleMemberIds: string[] = [];
          if (roleMentionIds.length > 0) {
            const roleMembers = await db
              .select({ userId: spaceMemberRolesTable.userId })
              .from(spaceMemberRolesTable)
              .where(
                sql`${spaceMemberRolesTable.roleId} = ANY(ARRAY[${sql.raw(roleMentionIds.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
              );
            roleMemberIds = roleMembers
              .map((row) => row.userId.toString())
              .filter((id) => id !== user.id);
          }
          const allCandidates = Array.from(
            new Set([...uniqueMembers, ...roleMemberIds]),
          );
          const filteredMembers: string[] = [];

          for (const memberId of allCandidates) {
            const ctx = {
              isDirectMention: directMentionIds.has(memberId),
              isRoleMention:
                roleMemberIds.includes(memberId) &&
                !directMentionIds.has(memberId),
              isEveryoneMention: everyoneMentions.length > 0,
              isHereMention: hereMentions.length > 0,
              isRegularMessage: false,
            };
            const resolved = await resolveChannelNotificationForUser(
              memberId,
              channel.id,
              channel.spaceId,
            );
            if (
              shouldIncrementMentionCount(
                resolved.level,
                ctx,
                resolved.suppress,
              )
            ) {
              filteredMembers.push(memberId);
            }
          }

          if (filteredMembers.length > 0) {
            await incrementMentionCounts(
              channel.id,
              filteredMembers,
              undefined,
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

  fireAndForgetAll([
    {
      label: "dm:reopen",
      run: async () => {
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
      },
    },
  ]);

  return { message, created: true };
}
