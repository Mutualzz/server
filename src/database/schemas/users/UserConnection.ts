import {
  bigint,
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const userConnectionsTable = pgTable(
  "user_connections",
  {
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    provider: text().notNull(),
    providerUserId: text().notNull(),
    displayName: text(),
    externalUrl: text(),
    accessToken: text(),
    refreshToken: text(),
    expiresAt: timestamp(),
    shareOnProfile: boolean().notNull().default(true),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.provider] }),
    uniqueIndex("user_connections_provider_user_uidx").on(
      table.provider,
      table.providerUserId,
    ),
  ],
);
