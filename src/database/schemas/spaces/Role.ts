import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    integer,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { spacesTable } from "./Space";

export const rolesTable = pgTable("roles", {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    space: text()
        .notNull()
        .references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

    hoist: boolean().notNull().default(false),
    permissions: bigint("permissions", { mode: "bigint" })
        .notNull()
        .default(sql`0`),
    position: integer().notNull().default(0),
    color: integer().notNull().default(0),
    mentionable: boolean().notNull().default(false),
    flags: bigint("flags", { mode: "bigint" })
        .notNull()
        .default(sql`0`),

    created: timestamp({ withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow(),

    updated: timestamp({ withTimezone: true, mode: "date" })
        .defaultNow()
        .notNull()
        .$onUpdate(() => new Date()),
});
