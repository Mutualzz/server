import type { NotificationType } from "@mutualzz/types";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";

export const notificationsTable = pgTable(
  "notifications",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text().$type<NotificationType>().notNull(),
    actorId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
      onDelete: "set null",
    }),
    channelId: bigint({ mode: "bigint" }),
    messageId: bigint({ mode: "bigint" }),
    data: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    readAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId, table.id.desc()),
    index("notifications_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} is null`),
    index("notifications_created_at_idx").on(table.createdAt),
  ],
);

export const notificationRelations = relations(
  notificationsTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [notificationsTable.userId],
      references: [usersTable.id],
    }),
    actor: one(usersTable, {
      fields: [notificationsTable.actorId],
      references: [usersTable.id],
    }),
  }),
);
