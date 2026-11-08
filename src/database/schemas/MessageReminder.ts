import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./channel";
import { messagesTable } from "./Message";
import { usersTable } from "./users/User";

export const messageRemindersTable = pgTable(
  "message_reminders",
  {
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    messageId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    channelId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),

    remindAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    firedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("message_reminders_uq").on(table.userId, table.messageId),
    index("message_reminders_user_remind_at_idx").on(
      table.userId,
      table.remindAt,
    ),
    index("message_reminders_pending_idx")
      .on(table.remindAt)
      .where(sql`${table.firedAt} is null`),
  ],
);

export const messageReminderRelations = relations(
  messageRemindersTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [messageRemindersTable.userId],
      references: [usersTable.id],
    }),
    message: one(messagesTable, {
      fields: [messageRemindersTable.messageId],
      references: [messagesTable.id],
    }),
    channel: one(channelsTable, {
      fields: [messageRemindersTable.channelId],
      references: [channelsTable.id],
    }),
  }),
);
