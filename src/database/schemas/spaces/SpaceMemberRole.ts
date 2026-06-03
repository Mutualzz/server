import {
    bigint,
    foreignKey,
    index,
    pgTable,
    primaryKey,
    timestamp,
} from "drizzle-orm/pg-core";
import { rolesTable } from "./Role";
import { spacesTable } from "./Space";
import { spaceMembersTable } from "./SpaceMember";

export const spaceMemberRolesTable = pgTable(
    "space_member_roles",
    {
        roleId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => rolesTable.id, { onDelete: "cascade" }),

        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, { onDelete: "cascade" }),

        userId: bigint({ mode: "bigint" }).notNull(),

        assignedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
    },
    (t) => [
        primaryKey({ columns: [t.spaceId, t.userId, t.roleId] }),
        index("smr_space_id_idx").on(t.spaceId),
        index("smr_user_id_idx").on(t.userId),
        index("smr_role_id_idx").on(t.roleId),
        foreignKey({
            columns: [t.spaceId, t.userId],
            foreignColumns: [
                spaceMembersTable.spaceId,
                spaceMembersTable.userId,
            ],
            name: "smr_space_member_fkey",
        }).onDelete("cascade"),
    ],
);
