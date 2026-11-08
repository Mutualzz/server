import { db, scheduledMessagesTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { Snowflake } from "@mutualzz/util";
import {
  readAttachmentSpoilers,
  uploadMessageAttachments,
} from "@mutualzz/util/messages/attachments";
import {
  assertCanScheduleIn,
  emitScheduledMessageUpdate,
  serializeScheduledMessage,
} from "@mutualzz/util/messages/scheduledMessages";
import {
  MAX_SCHEDULED_MESSAGES,
  validateMessageParamsPut,
  validateScheduledMessageBodyPut,
} from "@mutualzz/validators";
import { count, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class ScheduledMessagesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { channelId } = validateMessageParamsPut.parse(req.params);

      const {
        content,
        repliedToId,
        mentionReply = true,
        expressionIds = [],
        sharedPostId,
        codedLinks = [],
        scheduledFor,
        attachmentSpoilers: validatedAttachmentSpoilers = [],
      } = validateScheduledMessageBodyPut.parse(req.body);

      const files: Express.Multer.File[] = Array.isArray(req.files)
        ? req.files
        : [];

      const isEmpty =
        !content &&
        expressionIds.length === 0 &&
        files.length === 0 &&
        !sharedPostId &&
        codedLinks.length === 0;

      if (isEmpty)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Message must have content, stickers, or attachments",
        );

      await assertCanScheduleIn(user, channelId, files.length > 0);

      const [{ total }] = await db
        .select({ total: count() })
        .from(scheduledMessagesTable)
        .where(eq(scheduledMessagesTable.authorId, BigInt(user.id)));

      if (total >= MAX_SCHEDULED_MESSAGES)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          `You can schedule up to ${MAX_SCHEDULED_MESSAGES} messages`,
        );

      const id = BigInt(Snowflake.generate());

      const attachments =
        files.length > 0
          ? await uploadMessageAttachments(
              id.toString(),
              files,
              readAttachmentSpoilers(req.body, validatedAttachmentSpoilers),
            )
          : [];

      const [row] = await db
        .insert(scheduledMessagesTable)
        .values({
          id,
          authorId: BigInt(user.id),
          channelId: BigInt(channelId),
          content: content || null,
          repliedToId: repliedToId ? BigInt(repliedToId) : null,
          mentionReply,
          expressionIds: expressionIds.map((expressionId) =>
            BigInt(expressionId),
          ),
          sharedPostId: sharedPostId ? BigInt(sharedPostId) : null,
          codedLinks,
          attachments,
          scheduledFor: new Date(scheduledFor),
        })
        .returning();

      await emitScheduledMessageUpdate(row);
      res.status(HttpStatusCode.Created).json(serializeScheduledMessage(row));
    } catch (err) {
      next(err);
    }
  }
}
