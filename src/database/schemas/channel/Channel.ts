import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    pgTable,
    smallint,
    text,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { spacesTable } from "../spaces";
import { usersTable } from "../users";

export const channelsTable = pgTable(
    "channels",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        type: smallint().notNull(),

        spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        name: text(),

        // This will be assigned if the channel is a Group DMChannel
        ownerId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
            onDelete: "set null",
        }),
        topic: text(),
        position: smallint().notNull().default(0),
        parentId: bigint({ mode: "bigint" }).references(
            (): any => channelsTable.id,
            {
                onDelete: "set null",
            },
        ),

        icon: text(),

        nsfw: boolean().notNull().default(false),

        flags: bigint({ mode: "bigint" })
            .notNull()
            .default(sql`0`),

        lastMessageId: bigint({ mode: "bigint" }),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        uniqueIndex("channel_space_parent_position_uq").on(
            table.spaceId,
            table.parentId,
            table.position,
        ),
        index("channel_space_id_idx").on(table.spaceId),
        index("channel_owner_id_idx").on(table.ownerId),
        index("channel_parent_id_idx").on(table.parentId),
        index("channel_created_at_idx").on(table.createdAt),
        index("channel_type_idx").on(table.type),
        index("channel_last_message_id_idx").on(table.lastMessageId),
    ],
);
