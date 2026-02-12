import {
    bigint,
    index,
    pgTable,
    primaryKey,
    timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./Channel";
import { rolesTable, spacesTable } from "./spaces";
import { usersTable } from "./users";
import { sql } from "drizzle-orm";

export const channelPermissionOverwritesTable = pgTable(
    "channel_permission_overwrites",
    {
        channelId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => channelsTable.id, { onDelete: "cascade" }),

        spaceId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => spacesTable.id, { onDelete: "cascade" }),

        roleId: bigint({ mode: "bigint" }).references(() => rolesTable.id, {
            onDelete: "cascade",
        }),
        userId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
            onDelete: "cascade",
        }),

        allow: bigint({ mode: "bigint" })
            .notNull()
            .default(sql`0`),
        deny: bigint({ mode: "bigint" })
            .notNull()
            .default(sql`0`),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        primaryKey({ columns: [table.channelId, table.roleId, table.userId] }),
        index("cpo_channel_id_idx").on(table.channelId),
        index("cpo_space_id_idx").on(table.spaceId),
        index("cpo_role_id_idx").on(table.roleId),
        index("cpo_user_id_idx").on(table.userId),
    ],
);
