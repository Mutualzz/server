import {
  bigint,
  boolean,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const userSpotifyConnectionsTable = pgTable("user_spotify_connections", {
  userId: bigint({ mode: "bigint" })
    .primaryKey()
    .references(() => usersTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  spotifyUserId: text().notNull(),
  displayName: text(),
  externalUrl: text(),
  accessToken: text().notNull(),
  refreshToken: text().notNull(),
  expiresAt: timestamp().notNull(),
  shareSpotify: boolean().notNull().default(true),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
