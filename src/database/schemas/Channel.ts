import { relations, sql } from "drizzle-orm";
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
import { messagesTable } from "./Message";
import { spacesTable } from "./spaces";
import { usersTable } from "./users";
import { channelPermissionOverwritesTable } from "./ChannelPermissionOverwrite";

export const channelsTable = pgTable(
    "channels",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        type: smallint().notNull(),

        spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        name: text(),

        // This will be assigned if the channel is a Group DM
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

        // For direct messages, this will contain the list of user IDs
        recipientIds: bigint({ mode: "bigint" }).array(),

        nsfw: boolean().notNull().default(false),

        lastMessageId: bigint({ mode: "bigint" }).references(
            (): any => messagesTable.id,
            {
                onDelete: "set null",
            },
        ),

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
    ],
);

export const channelRelations = relations(channelsTable, ({ one, many }) => ({
    space: one(spacesTable, {
        fields: [channelsTable.spaceId],
        references: [spacesTable.id],
    }),
    owner: one(usersTable, {
        fields: [channelsTable.ownerId],
        references: [usersTable.id],
    }),
    parent: one(channelsTable, {
        fields: [channelsTable.parentId],
        references: [channelsTable.id],
    }),
    recipients: many(usersTable),
    messages: many(messagesTable),
    lastMessage: one(messagesTable, {
        fields: [channelsTable.lastMessageId],
        references: [messagesTable.id],
    }),
    overwrites: many(channelPermissionOverwritesTable),
}));

export const channelOverwriteRelations = relations(
    channelPermissionOverwritesTable,
    ({ one }) => ({
        channel: one(channelsTable, {
            fields: [channelPermissionOverwritesTable.channelId],
            references: [channelsTable.id],
        }),
    }),
);
