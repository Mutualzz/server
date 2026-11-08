import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { db, scheduledMessagesTable } from "@mutualzz/database";
import {
  type APIAttachment,
  type APIPrivateUser,
  type APIScheduledMessage,
  ChannelType,
  HttpException,
  HttpStatusCode,
} from "@mutualzz/types";
import { and, eq, lt, lte } from "drizzle-orm";
import { getChannel, getUser, isChannelRecipient } from "../Helpers.ts";
import { requireChannelPermissions } from "../permissions/channel.ts";
import { requireNotRestricted } from "../permissions/restriction.ts";
import { emitEvent } from "../RabbitMQ.ts";
import { bucketName, s3Client } from "../S3.ts";
import { createNotification } from "../notifications.ts";
import { createMessage } from "./createMessage.ts";

type ScheduledMessageRow = typeof scheduledMessagesTable.$inferSelect;

const SENDING_TIMEOUT_MS = 2 * 60_000;

export const serializeScheduledMessage = (
  row: ScheduledMessageRow,
): APIScheduledMessage => ({
  id: row.id.toString(),
  channelId: row.channelId.toString(),
  content: row.content,
  repliedToId: row.repliedToId?.toString() ?? null,
  mentionReply: row.mentionReply,
  expressionIds: row.expressionIds.map((expressionId) =>
    expressionId.toString(),
  ),
  sharedPostId: row.sharedPostId?.toString() ?? null,
  codedLinks: row.codedLinks,
  attachments: row.attachments,
  scheduledFor: row.scheduledFor.toISOString(),
  status: row.status,
  failureReason: row.failureReason,
  createdAt: row.createdAt.toISOString(),
});

export const emitScheduledMessageUpdate = (row: ScheduledMessageRow) =>
  emitEvent({
    event: "ScheduledMessageUpdate",
    user_id: row.authorId.toString(),
    data: serializeScheduledMessage(row),
  });

export const emitScheduledMessageDelete = (
  row: ScheduledMessageRow,
  sentMessageId: string | null,
) =>
  emitEvent({
    event: "ScheduledMessageDelete",
    user_id: row.authorId.toString(),
    data: {
      id: row.id.toString(),
      channelId: row.channelId.toString(),
      sentMessageId,
    },
  });

export const assertCanScheduleIn = async (
  author: APIPrivateUser,
  channelId: string,
  hasAttachments: boolean,
) => {
  requireNotRestricted(author);

  const channel = await getChannel(channelId);
  if (!channel)
    throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

  const isDirect =
    channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM;
  const isSendable =
    isDirect ||
    channel.type === ChannelType.Text ||
    channel.type === ChannelType.Voice;

  if (!isSendable)
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Message cannot be sent in this channel",
    );

  if (isDirect) {
    if (!(await isChannelRecipient(channel.id, author.id)))
      throw new HttpException(
        HttpStatusCode.Forbidden,
        "You are not part of this DM Channel",
      );
    return channel;
  }

  await requireChannelPermissions({
    channelId: channel.id,
    userId: author.id,
    needed: hasAttachments
      ? ["ViewChannel", "SendMessages", "AttachFiles"]
      : ["ViewChannel", "SendMessages"],
  });

  return channel;
};

export const deleteScheduledAttachments = (attachments: APIAttachment[]) =>
  Promise.all(
    attachments.map((attachment) => {
      const keyStart = attachment.url.indexOf("attachments/");
      if (keyStart === -1) return undefined;

      return s3Client
        .send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: attachment.url.slice(keyStart),
          }),
        )
        .catch(() => undefined);
    }),
  );

const failureReasonFor = (error: unknown) =>
  error instanceof HttpException
    ? error.message
    : "Something went wrong while sending";

const sendScheduledMessage = async (row: ScheduledMessageRow) => {
  try {
    const author = await getUser(row.authorId.toString(), true);
    if (!author)
      throw new HttpException(
        HttpStatusCode.NotFound,
        "Your account could not be found",
      );

    const { message } = await createMessage({
      author,
      channelId: row.channelId.toString(),
      content: row.content ?? undefined,
      repliedToId: row.repliedToId?.toString(),
      mentionReply: row.mentionReply,
      expressionIds: row.expressionIds.map((expressionId) =>
        expressionId.toString(),
      ),
      sharedPostId: row.sharedPostId?.toString(),
      codedLinks: row.codedLinks,
      preparedAttachments: row.attachments,
    });

    await db
      .delete(scheduledMessagesTable)
      .where(eq(scheduledMessagesTable.id, row.id));
    await emitScheduledMessageDelete(row, message.id.toString());
    await createNotification({
      userId: row.authorId.toString(),
      type: "scheduled_sent",
      channelId: row.channelId.toString(),
      messageId: message.id.toString(),
    });
  } catch (error) {
    const [failed] = await db
      .update(scheduledMessagesTable)
      .set({
        status: "failed",
        failureReason: failureReasonFor(error),
        updatedAt: new Date(),
      })
      .where(eq(scheduledMessagesTable.id, row.id))
      .returning();

    if (failed) {
      await emitScheduledMessageUpdate(failed);
      await createNotification({
        userId: failed.authorId.toString(),
        type: "scheduled_failed",
        channelId: failed.channelId.toString(),
        data: {
          reason: failed.failureReason ?? "",
          scheduledMessageId: failed.id.toString(),
        },
      });
    }
  }
};

const failInterruptedSends = async (now: Date) => {
  const interrupted = await db
    .update(scheduledMessagesTable)
    .set({
      status: "failed",
      failureReason:
        "Sending was interrupted. Check the channel before trying again.",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledMessagesTable.status, "sending"),
        lt(
          scheduledMessagesTable.updatedAt,
          new Date(now.getTime() - SENDING_TIMEOUT_MS),
        ),
      ),
    )
    .returning();

  await Promise.all(interrupted.map(emitScheduledMessageUpdate));
};

export const sendDueScheduledMessages = async () => {
  const now = new Date();

  await failInterruptedSends(now);

  const claimed = await db
    .update(scheduledMessagesTable)
    .set({ status: "sending", updatedAt: now })
    .where(
      and(
        eq(scheduledMessagesTable.status, "pending"),
        lte(scheduledMessagesTable.scheduledFor, now),
      ),
    )
    .returning();

  for (const row of claimed) await sendScheduledMessage(row);

  return claimed.length;
};
