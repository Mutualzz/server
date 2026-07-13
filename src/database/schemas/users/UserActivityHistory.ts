import {
  bigint,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PresenceActivityAssets } from "@mutualzz/types";
import { usersTable } from "./User";

export const userActivityHistoryTable = pgTable(
  "user_activity_history",
  {
    id: serial().primaryKey(),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    type: text().notNull(),
    name: text().notNull(),
    applicationId: text(),
    details: text(),
    state: text(),
    url: text(),
    assets: jsonb().$type<PresenceActivityAssets | null>(),
    startedAt: timestamp(),
    endedAt: timestamp().notNull().defaultNow(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("user_activity_history_user_ended_idx").on(
      table.userId,
      table.endedAt,
    ),
  ],
);
