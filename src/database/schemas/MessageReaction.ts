import { expressionsTable } from "./Expression";
import { messagesTable } from "./Message";
import { usersTable } from "./users/User";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const messageReactionsTable = pgTable(
  "message_reactions",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),

    messageId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),

    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    unicode: text(),
    expressionId: bigint({ mode: "bigint" }).references(
      () => expressionsTable.id,
      { onDelete: "cascade" },
    ),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("message_reactions_unicode_uq")
      .on(table.messageId, table.userId, table.unicode)
      .where(sql`${table.expressionId} is null`),
    uniqueIndex("message_reactions_expression_uq")
      .on(table.messageId, table.userId, table.expressionId)
      .where(sql`${table.unicode} is null`),
    index("message_reactions_message_id_idx").on(table.messageId),
    index("message_reactions_expression_id_idx").on(table.expressionId),
  ],
);

export const messageReactionRelations = relations(
  messageReactionsTable,
  ({ one }) => ({
    message: one(messagesTable, {
      fields: [messageReactionsTable.messageId],
      references: [messagesTable.id],
    }),
    user: one(usersTable, {
      fields: [messageReactionsTable.userId],
      references: [usersTable.id],
    }),
    expression: one(expressionsTable, {
      fields: [messageReactionsTable.expressionId],
      references: [expressionsTable.id],
    }),
  }),
);
