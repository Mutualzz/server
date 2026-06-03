import {
    bigint,
    integer,
    pgTable,
    primaryKey,
    smallint,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";
import { channelsTable } from "@mutualzz/database";
import { sql } from "drizzle-orm";

export const readStatesTable = pgTable(
    "read_states",
    {
        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),
        channelId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => channelsTable.id, { onDelete: "cascade" }),
        type: smallint().notNull().default(0),

        lastMessageId: bigint({ mode: "bigint" }),
        notificationsCursor: bigint({ mode: "bigint" }),
        lastAckedId: bigint({ mode: "bigint" }),
        mentionCount: integer().notNull().default(0),
        lastPinTimestamp: timestamp({ mode: "date", withTimezone: true }),
        badgeCount: integer().notNull().default(0),
        flags: bigint({ mode: "bigint" })
            .notNull()
            .default(sql`0`),
        updatedAt: timestamp({ mode: "date", withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.channelId, table.type] }),
    ],
);
