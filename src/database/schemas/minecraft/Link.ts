import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";
import { bridgesTable } from "./Bridge";

/**
 * Global identity link: Mutualzz user ↔ Minecraft UUID (Discord optional).
 * One Minecraft account maps to one Mutualzz user.
 */
export const minecraftLinksTable = pgTable(
  "minecraft_links",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    minecraftUuid: uuid().notNull(),
    minecraftName: text().notNull(),
    discordId: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("minecraft_link_user_id_uq").on(table.userId),
    uniqueIndex("minecraft_link_uuid_uq").on(table.minecraftUuid),
    index("minecraft_link_discord_id_idx").on(table.discordId),
  ],
);

export const minecraftLinkRelations = relations(
  minecraftLinksTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [minecraftLinksTable.userId],
      references: [usersTable.id],
    }),
  }),
);

/** Short-lived codes for /link in-game, Discord, or the app. */
export const minecraftLinkCodesTable = pgTable(
  "minecraft_link_codes",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    code: text().notNull().unique(),
    userId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Which bridge initiated the code (optional context) */
    bridgeId: bigint({ mode: "bigint" }).references(() => bridgesTable.id, {
      onDelete: "set null",
    }),
    minecraftUuid: uuid(),
    minecraftName: text(),
    discordId: text(),
    expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("minecraft_link_code_code_idx").on(table.code),
    index("minecraft_link_code_user_id_idx").on(table.userId),
    index("minecraft_link_code_expires_at_idx").on(table.expiresAt),
  ],
);

export const minecraftLinkCodeRelations = relations(
  minecraftLinkCodesTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [minecraftLinkCodesTable.userId],
      references: [usersTable.id],
    }),
    bridge: one(bridgesTable, {
      fields: [minecraftLinkCodesTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);
