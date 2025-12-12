import {
    bigint,
    index,
    pgTable,
    primaryKey,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";
import { rolesTable } from "./Role";
import { spacesTable } from "./Space";

export const spaceMemberRolesTable = pgTable(
    "space_member_roles",
    {
        id: bigint({ mode: "bigint" })
            .notNull()
            .references(() => rolesTable.id, { onDelete: "cascade" }),
        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, { onDelete: "cascade" }),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),

        assignedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
    },
    (t) => [
        primaryKey({ columns: [t.spaceId, t.userId, t.id] }),
        index("smr_space_id_idx").on(t.spaceId),
        index("smr_user_id_idx").on(t.userId),
        index("smr_role_id_idx").on(t.id),
    ],
);
