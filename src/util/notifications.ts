import { db, notificationsTable, usersTable } from "@mutualzz/database";
import type { APINotification, NotificationType } from "@mutualzz/types";
import { MAX_NOTIFICATIONS_PER_USER } from "@mutualzz/validators";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
} from "drizzle-orm";
import { emitEvent } from "./RabbitMQ.ts";
import { sendInboxPush } from "./PushNotifications.ts";
import { Logger } from "@mutualzz/logger";

const logger = new Logger({ tag: "Notifications" });
import { Snowflake } from "./Snowflake.ts";

const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type NotificationRow = typeof notificationsTable.$inferSelect;

export const serializeNotification = (
  row: NotificationRow,
): APINotification => ({
  id: row.id.toString(),
  type: row.type,
  actorId: row.actorId?.toString() ?? null,
  channelId: row.channelId?.toString() ?? null,
  messageId: row.messageId?.toString() ?? null,
  data: row.data,
  createdAt: row.createdAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
});

interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  data?: Record<string, string>;
}

const trimToLimit = async (userId: bigint) => {
  const newest = db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, userId))
    .orderBy(desc(notificationsTable.id))
    .limit(MAX_NOTIFICATIONS_PER_USER);

  await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, userId),
        notInArray(notificationsTable.id, newest),
      ),
    );
};

export const createNotification = async (input: CreateNotificationInput) => {
  const userId = BigInt(input.userId);

  const [row] = await db
    .insert(notificationsTable)
    .values({
      id: BigInt(Snowflake.generate()),
      userId,
      type: input.type,
      actorId: input.actorId ? BigInt(input.actorId) : null,
      channelId: input.channelId ? BigInt(input.channelId) : null,
      messageId: input.messageId ? BigInt(input.messageId) : null,
      data: input.data ?? {},
    })
    .returning();

  await trimToLimit(userId);

  await emitEvent({
    event: "NotificationCreate",
    user_id: input.userId,
    data: serializeNotification(row),
  });

  void pushNotification(input).catch((error) =>
    logger.warn("Inbox push failed", error),
  );

  return row;
};

const pushContent = async (
  input: CreateNotificationInput,
): Promise<{ title: string; body: string } | null> => {
  switch (input.type) {
    case "reminder":
      return {
        title: "Reminder",
        body: "A message you wanted to come back to is due.",
      };
    case "scheduled_failed":
      return {
        title: "Scheduled message not sent",
        body: input.data?.reason || "Your scheduled message couldn't be sent.",
      };
    case "friend_accepted": {
      const actor = input.actorId
        ? await db.query.usersTable.findFirst({
            columns: { username: true, globalName: true },
            where: eq(usersTable.id, BigInt(input.actorId)),
          })
        : null;
      const name = actor?.globalName || actor?.username || "Someone";
      return {
        title: "Friend request accepted",
        body: `${name} accepted your friend request.`,
      };
    }
    case "scheduled_sent":
      return null;
  }
};

const pushNotification = async (input: CreateNotificationInput) => {
  const content = await pushContent(input);
  if (!content) return;
  await sendInboxPush({
    userId: input.userId,
    channelId: input.channelId,
    ...content,
  });
};

export const countUnreadNotifications = async (userId: string) => {
  const [{ total }] = await db
    .select({ total: count() })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, BigInt(userId)),
        isNull(notificationsTable.readAt),
      ),
    );
  return total;
};

export const markNotificationsRead = async (
  userId: string,
  ids: string[] | "all",
) => {
  const now = new Date();
  const conditions = [
    eq(notificationsTable.userId, BigInt(userId)),
    isNull(notificationsTable.readAt),
  ];
  if (ids !== "all")
    conditions.push(
      inArray(
        notificationsTable.id,
        ids.map((id) => BigInt(id)),
      ),
    );

  const updated = await db
    .update(notificationsTable)
    .set({ readAt: now })
    .where(and(...conditions))
    .returning({ id: notificationsTable.id });

  if (updated.length > 0)
    await emitEvent({
      event: "NotificationRead",
      user_id: userId,
      data: {
        ids: updated.map((row) => row.id.toString()),
        readAt: now.toISOString(),
      },
    });

  return updated.length;
};

export const deleteExpiredNotifications = async () => {
  const removed = await db
    .delete(notificationsTable)
    .where(
      lt(
        notificationsTable.createdAt,
        new Date(Date.now() - NOTIFICATION_TTL_MS),
      ),
    )
    .returning({ id: notificationsTable.id });
  return removed.length;
};
