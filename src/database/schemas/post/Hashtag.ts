import { relations } from "drizzle-orm";
import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { postsTable } from "./Post";

export const hashtagsTable = pgTable(
  "hashtags",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    tag: text().notNull(),
  },
  (table) => [uniqueIndex("hashtag_tag_uq").on(table.tag)],
);

export const postHashtagsTable = pgTable(
  "post_hashtags",
  {
    postId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    hashtagId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => hashtagsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("post_hashtag_uq").on(table.postId, table.hashtagId),
    index("post_hashtag_hashtag_id_idx").on(table.hashtagId),
  ],
);

export const hashtagRelations = relations(hashtagsTable, ({ many }) => ({
  posts: many(postHashtagsTable),
}));

export const postHashtagRelations = relations(postHashtagsTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [postHashtagsTable.postId],
    references: [postsTable.id],
  }),
  hashtag: one(hashtagsTable, {
    fields: [postHashtagsTable.hashtagId],
    references: [hashtagsTable.id],
  }),
}));
