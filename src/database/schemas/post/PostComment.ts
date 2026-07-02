import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import { postsTable } from "./Post";

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
    expressionIds: bigint({ mode: "bigint" }).array().default([]).notNull(),

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
}));
