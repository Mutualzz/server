import {
  bigint,
  index,
  jsonb,
  pgTable,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";
import type { APIUserProfileSnapshot } from "@mutualzz/types";
import { usersTable } from "./User";

export const userProfileVersionsTable = pgTable(
  "user_profile_versions",
  {
    id: serial().primaryKey(),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    snapshot: jsonb().$type<APIUserProfileSnapshot>().notNull(),
    savedAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("user_profile_versions_user_saved_idx").on(
      table.userId,
      table.savedAt,
    ),
  ],
);
