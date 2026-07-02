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

export const postSharesTable = pgTable(
  "post_shares",
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
    uniqueIndex("post_share_uq").on(table.postId, table.userId),
    index("post_share_post_id_idx").on(table.postId),
    index("post_share_user_id_idx").on(table.userId),
  ],
);

export const postShareRelations = relations(postSharesTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [postSharesTable.postId],
    references: [postsTable.id],
  }),
  user: one(usersTable, {
    fields: [postSharesTable.userId],
    references: [usersTable.id],
  }),
}));
