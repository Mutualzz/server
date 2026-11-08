import { relations } from "drizzle-orm";
import { bigint, pgTable, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { messagesTable } from "./Message";
import { usersTable } from "./users/User";

export const mentionDismissalsTable = pgTable(
  "mention_dismissals",
  {
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    messageId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.messageId] })],
);

export const mentionDismissalRelations = relations(
  mentionDismissalsTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [mentionDismissalsTable.userId],
      references: [usersTable.id],
    }),
    message: one(messagesTable, {
      fields: [mentionDismissalsTable.messageId],
      references: [messagesTable.id],
    }),
  }),
);
