import { rolesTable } from "@mutualzz/database/schemas";
import { spaceMemberRolesTable } from "@mutualzz/database/schemas/spaces/SpaceMemberRoles.ts";
import { relations, sql } from "drizzle-orm";
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

export const spaceMemberRelations = relations(
    spaceMembersTable,
    ({ one, many }) => ({
        user: one(usersTable, {
            fields: [spaceMembersTable.userId],
            references: [usersTable.id],
        }),
        space: one(spacesTable, {
            fields: [spaceMembersTable.spaceId],
            references: [spacesTable.id],
        }),
        roles: many(spaceMemberRolesTable),
    }),
);

export const spaceMemberRoleRelations = relations(
    spaceMemberRolesTable,
    ({ one }) => ({
        member: one(spaceMembersTable, {
            fields: [
                spaceMemberRolesTable.spaceId,
                spaceMemberRolesTable.userId,
            ],
            references: [spaceMembersTable.spaceId, spaceMembersTable.userId],
        }),
        role: one(rolesTable, {
            fields: [spaceMemberRolesTable.id],
            references: [rolesTable.id],
        }),
    }),
);
