import { relations } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// RPC applications: the ID is what games pass as `clientId` to @mutualzz/rpc
export const applicationsTable = pgTable(
    "applications",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        name: text().notNull(),
        description: text(),
        icon: text(),

        ownerId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [index("application_owner_id_idx").on(table.ownerId)],
);

export const applicationRelations = relations(applicationsTable, ({ one }) => ({
    owner: one(usersTable, {
        fields: [applicationsTable.ownerId],
        references: [usersTable.id],
    }),
}));
