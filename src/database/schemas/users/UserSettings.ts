import {
  bigint,
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./User";
import type { UserExtendedSettings } from "@mutualzz/types";

export const preferredModeEnum = pgEnum("preferred_mode", ["spaces", "feed"]);

export const userSettingsTable = pgTable("user_settings", {
  userId: bigint({ mode: "bigint" })
    .primaryKey()
    .references(() => usersTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),

  currentTheme: text().default("baseDark"),
  currentIcon: text(),

  preferredMode: preferredModeEnum().default("spaces").notNull(),
  preferEmbossed: boolean().notNull().default(false),

  preferredSelfMute: boolean().notNull().default(false),
  preferredSelfDeaf: boolean().notNull().default(false),

  spacePositions: bigint({ mode: "bigint" }).array().default([]).notNull(),

  favoriteEmojis: text().array().default([]).notNull(),
  favoriteGifs: text().array().default([]).notNull(),
  favoriteStickers: text().array().default([]).notNull(),

  pushEnabled: boolean().notNull().default(true),
  pushDirectMessages: boolean().notNull().default(true),
  pushMentions: boolean().notNull().default(true),

  shareActivity: boolean().notNull().default(true),
  shareRecentActivity: boolean().notNull().default(true),

  lastSeenChangelogId: bigint({ mode: "bigint" }),

  extendedSettings: jsonb()
    .$type<UserExtendedSettings>()
    .notNull()
    .default({} as UserExtendedSettings),

  updatedAt: timestamp()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
