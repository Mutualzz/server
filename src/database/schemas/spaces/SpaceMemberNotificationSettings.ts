import {
  bigint,
  boolean,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import { spacesTable } from "./Space";

export const spaceMemberNotificationSettingsTable = pgTable(
  "space_member_notification_settings",
  {
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    spaceId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => spacesTable.id, { onDelete: "cascade" }),
    level: smallint().notNull().default(1),
    mutedUntil: timestamp({ mode: "date", withTimezone: true }),
    suppressEveryone: boolean().notNull().default(false),
    suppressRoles: boolean().notNull().default(false),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.spaceId] })],
);
