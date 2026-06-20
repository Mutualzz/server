import { invalidateCache } from "@mutualzz/cache";
import { db, messageReactionsTable, messagesTable } from "@mutualzz/database";
import {
  type APIChannel,
  ChannelType,
  HttpException,
  HttpStatusCode,
} from "@mutualzz/types";
import {
  buildReactionEmojiPayload,
  countDistinctReactionEmojis,
  deleteAllReactions,
  deleteReactionsForEmoji,
  deleteUserReaction,
  emitEvent,
  emojiUsedOnMessage,
  fireAndForgetAll,
  getChannel,
  getMember,
  getReactionUsers,
  getUser,
  hasAnyReactionForEmoji,
  isChannelRecipient,
  MAX_REACTIONS_PER_MESSAGE,
  parseReactionEmojiInput,
  parseReactionUsersQueryEmoji,
  reactionExistsForUser,
  requireChannelPermissions,
  Snowflake,
  validateReactionExpression,
} from "@mutualzz/util";
import {
  validateReactionEmojiBody,
  validateReactionParams,
  validateReactionUserParams,
  validateReactionUsersQuery,
} from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class ReactionsController {
  private static async getMessageInChannel(
    channelId: string,
    messageId: string,
  ) {
    const message = await db.query.messagesTable.findFirst({
      where: and(
        eq(messagesTable.id, BigInt(messageId)),
        eq(messagesTable.channelId, BigInt(channelId)),
      ),
    });

    if (!message) {
      throw new HttpException(HttpStatusCode.NotFound, "Message not found");
    }

    return message;
  }

  private static async assertChannelAccess(
    channel: APIChannel,
    userId: string,
    needed: ("ViewChannel" | "ReadMessageHistory" | "AddReactions" | "ManageMessages")[] = [],
  ) {
    switch (channel.type) {
      case ChannelType.DM:
      case ChannelType.GroupDM:
        if (!(await isChannelRecipient(channel.id, userId))) {
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not part of this DM Channel",
          );
        }
        return;
      default:
        if (
          channel.spaceId &&
          !(await getMember(channel.spaceId, userId, true))
        ) {
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a member of this space",
          );
        }
    }

    if (channel.spaceId && needed.length > 0) {
      await requireChannelPermissions({
        channelId: channel.id,
        userId,
        needed,
      });
    }
  }

  private static async canUseExternalEmojis(
    channel: APIChannel,
    userId: string,
  ) {
    if (!channel.spaceId) return true;

    try {
      const { permissions } = await requireChannelPermissions({
        channelId: channel.id,
        userId,
        needed: ["UseExternalEmojis"],
        mode: "Any",
      });
      return permissions.has("UseExternalEmojis");
    } catch {
      return false;
    }
  }

  private static invalidateMessageCaches(channelId: string, messageId: string) {
    void invalidateCache("messages", channelId);
    void invalidateCache("message", messageId);
  }

  static async add(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateReactionParams.parse(req.params);
      const { emoji } = validateReactionEmojiBody.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      const message = await ReactionsController.getMessageInChannel(
        channelId,
        messageId,
      );

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
      ]);

      const { unicode, expressionId } = parseReactionEmojiInput(emoji);

      if (expressionId) {
        await validateReactionExpression({
          expressionId: expressionId.toString(),
          channel,
          userId: user.id,
          canUseExternalEmojis:
            await ReactionsController.canUseExternalEmojis(channel, user.id),
        });
      }

      const messageIdBig = BigInt(messageId);
      const userIdBig = BigInt(user.id);

      const alreadyReacted = await reactionExistsForUser({
        messageId: messageIdBig,
        userId: userIdBig,
        unicode,
        expressionId,
      });

      if (alreadyReacted) {
        return res.status(HttpStatusCode.NoContent).send();
      }

      const emojiAlreadyOnMessage = await emojiUsedOnMessage({
        messageId: messageIdBig,
        unicode,
        expressionId,
      });

      if (!emojiAlreadyOnMessage) {
        if (channel.spaceId) {
          await requireChannelPermissions({
            channelId: channel.id,
            userId: user.id,
            needed: ["AddReactions"],
          });
        }

        const distinctCount = await countDistinctReactionEmojis(messageIdBig);
        if (distinctCount >= MAX_REACTIONS_PER_MESSAGE) {
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Maximum number of reactions reached",
          );
        }
      }

      await db.insert(messageReactionsTable).values({
        id: BigInt(Snowflake.generate()),
        messageId: messageIdBig,
        userId: userIdBig,
        unicode,
        expressionId,
      });

      res.status(HttpStatusCode.NoContent).send();

      const reactionEmoji = await buildReactionEmojiPayload(
        unicode,
        expressionId,
      );

      fireAndForgetAll([
        {
          label: "cache:messages",
          run: () =>
            ReactionsController.invalidateMessageCaches(channelId, messageId),
        },
        {
          label: "event:MessageReactionAdd",
          run: async () =>
            emitEvent({
              event: "MessageReactionAdd",
              channel_id: channel.id,
              data: {
                channelId: channel.id,
                messageId,
                spaceId: channel.spaceId ?? null,
                userId: user.id,
                user: await getUser(user.id),
                emoji: reactionEmoji,
                messageAuthorId: message.authorId?.toString() ?? undefined,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async removeOwn(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateReactionParams.parse(req.params);
      const { emoji } = validateReactionEmojiBody.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      await ReactionsController.getMessageInChannel(channelId, messageId);

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
      ]);

      const { unicode, expressionId } = parseReactionEmojiInput(emoji);

      const removed = await deleteUserReaction({
        messageId: BigInt(messageId),
        userId: BigInt(user.id),
        unicode,
        expressionId,
      });

      if (!removed) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Reaction not found",
        );
      }

      res.status(HttpStatusCode.NoContent).send();

      const reactionEmoji = await buildReactionEmojiPayload(
        unicode,
        expressionId,
      );

      fireAndForgetAll([
        {
          label: "cache:messages",
          run: () =>
            ReactionsController.invalidateMessageCaches(channelId, messageId),
        },
        {
          label: "event:MessageReactionRemove",
          run: () =>
            emitEvent({
              event: "MessageReactionRemove",
              channel_id: channel.id,
              data: {
                channelId: channel.id,
                messageId,
                spaceId: channel.spaceId ?? null,
                userId: user.id,
                emoji: reactionEmoji,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async removeUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId, userId } =
        validateReactionUserParams.parse(req.params);
      const { emoji } = validateReactionEmojiBody.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      await ReactionsController.getMessageInChannel(channelId, messageId);

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
        "ManageMessages",
      ]);

      const { unicode, expressionId } = parseReactionEmojiInput(emoji);

      const removed = await deleteUserReaction({
        messageId: BigInt(messageId),
        userId: BigInt(userId),
        unicode,
        expressionId,
      });

      if (!removed) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Reaction not found",
        );
      }

      res.status(HttpStatusCode.NoContent).send();

      const reactionEmoji = await buildReactionEmojiPayload(
        unicode,
        expressionId,
      );

      fireAndForgetAll([
        {
          label: "cache:messages",
          run: () =>
            ReactionsController.invalidateMessageCaches(channelId, messageId),
        },
        {
          label: "event:MessageReactionRemove",
          run: () =>
            emitEvent({
              event: "MessageReactionRemove",
              channel_id: channel.id,
              data: {
                channelId: channel.id,
                messageId,
                spaceId: channel.spaceId ?? null,
                userId,
                emoji: reactionEmoji,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateReactionParams.parse(req.params);
      const query = validateReactionUsersQuery.parse(req.query);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      await ReactionsController.getMessageInChannel(channelId, messageId);

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
      ]);

      const { unicode, expressionId } = parseReactionUsersQueryEmoji(query);
      const limit = query.limit ?? 25;

      const rows = await getReactionUsers({
        messageId: BigInt(messageId),
        unicode,
        expressionId,
        after: query.after,
        limit,
      });

      res.status(HttpStatusCode.Success).json(
        rows.map((row) => row.user).filter(Boolean),
      );
    } catch (err) {
      next(err);
    }
  }

  static async removeAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateReactionParams.parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      await ReactionsController.getMessageInChannel(channelId, messageId);

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
        "ManageMessages",
      ]);

      await deleteAllReactions(BigInt(messageId));

      res.status(HttpStatusCode.NoContent).send();

      fireAndForgetAll([
        {
          label: "cache:messages",
          run: () =>
            ReactionsController.invalidateMessageCaches(channelId, messageId),
        },
        {
          label: "event:MessageReactionRemoveAll",
          run: () =>
            emitEvent({
              event: "MessageReactionRemoveAll",
              channel_id: channel.id,
              data: {
                channelId: channel.id,
                messageId,
                spaceId: channel.spaceId ?? null,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async removeEmoji(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId, messageId } = validateReactionParams.parse(req.params);
      const { emoji } = validateReactionEmojiBody.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel) {
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
      }

      await ReactionsController.getMessageInChannel(channelId, messageId);

      await ReactionsController.assertChannelAccess(channel, user.id, [
        "ViewChannel",
        "ReadMessageHistory",
        "ManageMessages",
      ]);

      const { unicode, expressionId } = parseReactionEmojiInput(emoji);

      const exists = await hasAnyReactionForEmoji(
        BigInt(messageId),
        unicode,
        expressionId,
      );

      if (!exists) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Reaction not found",
        );
      }

      await deleteReactionsForEmoji({
        messageId: BigInt(messageId),
        unicode,
        expressionId,
      });

      res.status(HttpStatusCode.NoContent).send();

      const reactionEmoji = await buildReactionEmojiPayload(
        unicode,
        expressionId,
      );

      fireAndForgetAll([
        {
          label: "cache:messages",
          run: () =>
            ReactionsController.invalidateMessageCaches(channelId, messageId),
        },
        {
          label: "event:MessageReactionRemoveEmoji",
          run: () =>
            emitEvent({
              event: "MessageReactionRemoveEmoji",
              channel_id: channel.id,
              data: {
                channelId: channel.id,
                messageId,
                spaceId: channel.spaceId ?? null,
                emoji: reactionEmoji,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
