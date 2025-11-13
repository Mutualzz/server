import { sql } from "drizzle-orm";
import {
    bigint,
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
        space: text()
            .notNull()
            .references(() => spacesTable.id, {
                onDelete: "cascade",
            }),

        user: text()
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
            }),

        nickname: text(),
        avatar: text(),
        banner: text(),

        roles: text().array().notNull().default([]),

        flags: bigint("flags", { mode: "bigint" })
            .notNull()
            .default(sql`0`),

        joined: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updated: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.space, table.user] }),
    }),
);
