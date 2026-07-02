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

export const postSavesTable = pgTable(
  "post_saves",
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
    uniqueIndex("post_save_uq").on(table.postId, table.userId),
    index("post_save_post_id_idx").on(table.postId),
    index("post_save_user_id_idx").on(table.userId),
  ],
);

export const postSaveRelations = relations(postSavesTable, ({ one }) => ({
  post: one(postsTable, {
    fields: [postSavesTable.postId],
    references: [postsTable.id],
  }),
  user: one(usersTable, {
    fields: [postSavesTable.userId],
    references: [usersTable.id],
  }),
}));
