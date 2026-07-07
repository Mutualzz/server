import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import { postsTable } from "./Post";
import type { APIMessageEmbed } from "@mutualzz/types";

export const postCommentsTable = pgTable(
  "post_comments",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),

    postId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),

    authorId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    content: text().notNull(),
    embeds: jsonb().$type<APIMessageEmbed[]>().notNull().default([]),
    expressionIds: bigint({ mode: "bigint" }).array().default([]).notNull(),

    repliedToId: bigint({ mode: "bigint" }).references(
      (): AnyPgColumn => postCommentsTable.id,
      { onDelete: "set null" },
    ),

    edited: boolean().default(false).notNull(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("post_comment_post_id_idx").on(table.postId),
    index("post_comment_post_id_created_at_idx").on(
      table.postId,
      table.createdAt,
    ),
    index("post_comment_replied_to_id_idx").on(table.repliedToId),
  ],
);

export const postCommentRelations = relations(postCommentsTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [postCommentsTable.postId],
    references: [postsTable.id],
  }),
  author: one(usersTable, {
    fields: [postCommentsTable.authorId],
    references: [usersTable.id],
  }),
  repliedTo: one(postCommentsTable, {
    fields: [postCommentsTable.repliedToId],
    references: [postCommentsTable.id],
  }),
}));
