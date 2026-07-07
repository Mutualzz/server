import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import type { APIAttachment, APIMessageEmbed } from "@mutualzz/types";
import { relations } from "drizzle-orm";

export const postsTable = pgTable(
  "posts",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    authorId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    content: text(),
    attachments: jsonb().$type<APIAttachment[]>().notNull().default([]),
    embeds: jsonb().$type<APIMessageEmbed[]>().notNull().default([]),
    expressionIds: bigint({ mode: "bigint" }).array().default([]).notNull(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),

    scheduledFor: timestamp({ withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("post_author_id_idx").on(table.authorId),
    index("post_created_at_idx").on(table.createdAt),
    index("post_scheduled_for_idx").on(table.scheduledFor),
  ],
);

export const postRelations = relations(postsTable, ({ one }) => ({
  author: one(usersTable, {
    fields: [postsTable.authorId],
    references: [usersTable.id],
  }),
}));
