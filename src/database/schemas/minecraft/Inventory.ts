import type { MinecraftInventoryData } from "@mutualzz/validators";
import {
  bigint,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bridgesTable } from "./Bridge";

export const minecraftInventoriesTable = pgTable(
  "minecraft_inventories",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    serverId: text().notNull(),
    minecraftUuid: text().notNull(),
    minecraftName: text().notNull(),
    inventory: jsonb()
      .$type<MinecraftInventoryData["inventory"]>()
      .notNull()
      .default([]),
    enderChest: jsonb()
      .$type<MinecraftInventoryData["enderChest"]>()
      .notNull()
      .default([]),
    capturedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("minecraft_inventory_player_uq").on(
      table.bridgeId,
      table.serverId,
      table.minecraftUuid,
    ),
  ],
);
