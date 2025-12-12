import { relations, sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    pgTable,
    smallint,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { spacesTable } from "./Space";

export const rolesTable = pgTable(
    "roles",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        name: text().notNull(),
        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, {
                onDelete: "cascade",
            }),

        hoist: boolean().notNull().default(false),
        permissions: bigint("permissions", { mode: "bigint" })
            .notNull()
            .default(sql`0`),
        position: smallint().notNull().default(0),
        color: text().notNull().default(`#99958e`),
        mentionable: boolean().notNull().default(false),
        flags: bigint("flags", { mode: "bigint" })
            .notNull()
            .default(sql`0`),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("roles_space_id_idx").on(table.spaceId),
        index("roles_position_idx").on(table.position),
        index("roles_created_at_idx").on(table.createdAt),
    ],
);

export const roleRelations = relations(rolesTable, ({ one }) => ({
    space: one(spacesTable, {
        fields: [rolesTable.spaceId],
        references: [spacesTable.id],
    }),
}));
