import { sql } from "drizzle-orm";
import {
    bigint,
    index,
    pgTable,
    primaryKey,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";
import { spacesTable } from "./Space";

export const spaceMembersTable = pgTable(
    "space_members",
    {
        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, {
                onDelete: "cascade",
            }),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
            }),

        nickname: text(),
        avatar: text(),
        banner: text(),

        flags: bigint("flags", { mode: "bigint" })
            .notNull()
            .default(sql`0`),

        joinedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        primaryKey({ columns: [table.spaceId, table.userId] }),
        index("space_members_space_id_idx").on(table.spaceId),
        index("space_members_user_id_idx").on(table.userId),
        index("space_members_joined_at_idx").on(table.joinedAt),
    ],
);
