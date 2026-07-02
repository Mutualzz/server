import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import { postsTable } from "./Post";

export const postLikesTable = pgTable(
  "post_likes",
  {
    postId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => postsTable.id, { onDelete: "cascade" }),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("post_like_uq").on(table.postId, table.userId),
    index("post_like_post_id_idx").on(table.postId),
    index("post_like_user_id_idx").on(table.userId),
  ],
);

export const postLikeRelations = relations(postLikesTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [postLikesTable.postId],
    references: [postsTable.id],
  }),
  user: one(usersTable, {
    fields: [postLikesTable.userId],
    references: [usersTable.id],
  }),
}));
