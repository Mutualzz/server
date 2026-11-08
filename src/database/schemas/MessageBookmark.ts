import { relations } from "drizzle-orm";
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

export const messageBookmarksTable = pgTable(
  "message_bookmarks",
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

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("message_bookmarks_uq").on(table.userId, table.messageId),
    index("message_bookmarks_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("message_bookmarks_message_id_idx").on(table.messageId),
  ],
);

export const messageBookmarkRelations = relations(
  messageBookmarksTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [messageBookmarksTable.userId],
      references: [usersTable.id],
    }),
    message: one(messagesTable, {
      fields: [messageBookmarksTable.messageId],
      references: [messagesTable.id],
    }),
    channel: one(channelsTable, {
      fields: [messageBookmarksTable.channelId],
      references: [channelsTable.id],
    }),
  }),
);
