import { sql } from "drizzle-orm";
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users";

export const spacesTable = pgTable("spaces", {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    owner: text()
        .notNull()
        .references(() => usersTable.id),

    description: text(),
    icon: text(),

    created: timestamp({ withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow(),

    updated: timestamp({ withTimezone: true, mode: "date" })
        .defaultNow()
        .notNull()
        .$onUpdate(() => new Date()),

    flags: bigint("flags", { mode: "bigint" })
        .notNull()
        .default(sql`0`),
});
