import { db, messageRemindersTable } from "@mutualzz/database";
import type { APIMessageReminder } from "@mutualzz/types";
import { and, isNull, lte } from "drizzle-orm";
import { emitEvent } from "./RabbitMQ.ts";
import { createNotification } from "./notifications.ts";

export const serializeReminder = (
  row: typeof messageRemindersTable.$inferSelect,
): APIMessageReminder => ({
  messageId: row.messageId.toString(),
  channelId: row.channelId.toString(),
  remindAt: row.remindAt.toISOString(),
  firedAt: row.firedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export const fireDueReminders = async () => {
  const now = new Date();

  const fired = await db
    .update(messageRemindersTable)
    .set({ firedAt: now })
    .where(
      and(
        isNull(messageRemindersTable.firedAt),
        lte(messageRemindersTable.remindAt, now),
      ),
    )
    .returning();

  await Promise.all(
    fired.map(async (row) => {
      await emitEvent({
        event: "MessageReminderUpdate",
        user_id: row.userId.toString(),
        data: serializeReminder(row),
      });
      await createNotification({
        userId: row.userId.toString(),
        type: "reminder",
        channelId: row.channelId.toString(),
        messageId: row.messageId.toString(),
      });
    }),
  );

  return fired.length;
};
