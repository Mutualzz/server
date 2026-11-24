import type { MentionType } from "@mutualzz/types";
import { relations } from "drizzle-orm";
import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { messagesTable } from "./Message";

export const messageMentionsTable = pgTable(
  "message_mentions",
  {
    targetId: bigint({ mode: "bigint" }).notNull(),
    messageId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    type: text().$type<Exclude<MentionType, "here">>().notNull(),
    channelId: bigint({ mode: "bigint" }).notNull(),
    spaceId: bigint({ mode: "bigint" }),
    authorId: bigint({ mode: "bigint" }),
  },
  (table) => [
    primaryKey({ columns: [table.targetId, table.messageId] }),
    index("message_mentions_message_id_idx").on(table.messageId),
  ],
);

export const messageMentionRelations = relations(
  messageMentionsTable,
  ({ one }) => ({
    message: one(messagesTable, {
      fields: [messageMentionsTable.messageId],
      references: [messagesTable.id],
    }),
  }),
);
