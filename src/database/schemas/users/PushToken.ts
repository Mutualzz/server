import {
    bigint,
    index,
    pgTable,
    primaryKey,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const pushTokensTable = pgTable(
    "push_tokens",
    {
        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),
        token: text().notNull(),
        platform: text().notNull(),
        updatedAt: timestamp({ mode: "date", withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.token] }),
        index("push_tokens_user_id_idx").on(table.userId),
    ],
);
