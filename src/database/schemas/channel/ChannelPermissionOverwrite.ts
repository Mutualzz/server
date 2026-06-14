import {
  bigint,
  index,
  pgTable,
  primaryKey,
  timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./Channel";
import { rolesTable, spacesTable } from "../spaces";
import { usersTable } from "../users";
import { sql } from "drizzle-orm";

export const channelRoleOverwritesTable = pgTable(
  "channel_role_overwrites",
  {
    channelId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),

    spaceId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => spacesTable.id, { onDelete: "cascade" }),

    roleId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => rolesTable.id, { onDelete: "cascade" }),

    allow: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),
    deny: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.roleId] }),
    index("cro_channel_id_idx").on(table.channelId),
    index("cro_space_id_idx").on(table.spaceId),
    index("cro_role_id_idx").on(table.roleId),
  ],
);

export const channelMemberOverwritesTable = pgTable(
  "channel_member_overwrites",
  {
    channelId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),

    spaceId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => spacesTable.id, { onDelete: "cascade" }),

    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    allow: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),
    deny: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
    index("cmo_channel_id_idx").on(table.channelId),
    index("cmo_space_id_idx").on(table.spaceId),
    index("cmo_user_id_idx").on(table.userId),
  ],
);
