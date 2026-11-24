import type {
  APIBadgeSettings,
  APIDisplayNameStyle,
  APIPrivateUser,
} from "@mutualzz/types";
import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

interface DefaultAvatar {
  type: number;
  color?: string | null;
}

export const usersTable = pgTable(
  "users",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    username: text().notNull().unique(),
    email: text().notNull().unique(),
    accentColor: text().notNull(),
    globalName: text(),
    pronouns: text(),
    displayNameStyle: jsonb().$type<APIDisplayNameStyle | null>(),
    badgeSettings: jsonb().$type<APIBadgeSettings | null>(),

    defaultAvatar: jsonb().$type<DefaultAvatar>().notNull(),
    avatar: text(),
    previousAvatars: text().array().default([]).notNull(),

    dateOfBirth: date().notNull(),

    hash: text().notNull(),

    discordId: bigint({ mode: "bigint" }),

    flags: bigint("flags", { mode: "bigint" })
      .notNull()
      .default(sql`0`),

    restrictedUntil: timestamp(),
    restrictionReason: text(),
    lastSeenAt: timestamp(),

    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("user_created_at_idx").on(table.createdAt),
    uniqueIndex("user_discord_id_idx")
      .on(table.discordId)
      .where(sql`${table.discordId} is not null`),
  ],
);

export const toPublicUser = (user: APIPrivateUser) => {
  if ("hash" in user) delete user.hash;
  const {
    dateOfBirth,
    previousAvatars,
    email,
    restrictedUntil,
    restrictionReason,
    lastSeenAt,
    ...publicUser
  } = user;
  return publicUser;
};
