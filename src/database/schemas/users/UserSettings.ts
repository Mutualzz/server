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
import type { ClientPreferences } from "@mutualzz/types";

export const dmPrivacyEnum = pgEnum("dm_privacy", [
  "everyone",
  "friends",
  "nobody",
]);
export const profileVisibilityEnum = pgEnum("profile_visibility", [
  "everyone",
  "friends",
  "nobody",
]);

export const userSettingsTable = pgTable("user_settings", {
  userId: bigint({ mode: "bigint" })
    .primaryKey()
    .references(() => usersTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),

  currentTheme: text().default("baseDark"),
  currentIcon: text(),

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

  whoCanDm: dmPrivacyEnum().notNull().default("everyone"),
  profileVisibility: profileVisibilityEnum().notNull().default("everyone"),

  clientPreferences: jsonb()
    .$type<ClientPreferences>()
    .notNull()
    .default({} as ClientPreferences),

  updatedAt: timestamp()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
