import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";
import { bridgesTable } from "./Bridge";

export const bridgeBansTable = pgTable(
  "bridge_bans",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    minecraftUuid: text().notNull(),
    minecraftName: text().notNull(),
    reason: text(),
    bannedById: bigint({ mode: "bigint" }).references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    liftedAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("bridge_ban_player_uq").on(table.bridgeId, table.minecraftUuid),
  ],
);

export const bridgeBanServersTable = pgTable(
  "bridge_ban_servers",
  {
    banId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgeBansTable.id, { onDelete: "cascade" }),
    serverId: text().notNull(),
    appliedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.banId, table.serverId] })],
);
