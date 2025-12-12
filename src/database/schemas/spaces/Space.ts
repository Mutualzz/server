import { channelsTable, spaceMembersTable } from "@mutualzz/database/schemas";
import { spaceMemberRolesTable } from "@mutualzz/database/schemas/spaces/SpaceMemberRoles.ts";
import { relations, sql } from "drizzle-orm";
import {
    bigint,
    index,
    integer,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";

export const spacesTable = pgTable(
    "spaces",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        name: text().notNull(),
        ownerId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id),

        description: text(),
        icon: text(),

        vanityCode: text().unique(),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),

        flags: bigint("flags", { mode: "bigint" })
            .notNull()
            .default(sql`0`),

        memberCount: integer().default(0).notNull(),
    },
    (table) => [
        index("space_owner_id_idx").on(table.ownerId),
        index("space_created_at_idx").on(table.createdAt),
    ],
);

export const spaceRelations = relations(spacesTable, ({ one, many }) => ({
    owner: one(usersTable, {
        fields: [spacesTable.ownerId],
        references: [usersTable.id],
    }),
    members: many(spaceMembersTable),
    channels: many(channelsTable),
    roles: many(spaceMemberRolesTable),
}));
