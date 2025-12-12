import { usersTable } from "@mutualzz/database/schemas/users";
import type { APIMessageEmbed } from "@mutualzz/types";
import { relations } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    jsonb,
    pgTable,
    smallint,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./Channel";
import { spacesTable } from "./spaces";

export const messagesTable = pgTable(
    "messages",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        type: smallint().notNull().default(0),

        authorId: bigint({ mode: "bigint" }).notNull(),
        channelId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => channelsTable.id, {
                onDelete: "cascade",
            }),

        spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        content: text(),

        edited: boolean().default(false).notNull(),

        embeds: jsonb().$type<APIMessageEmbed[]>().notNull().default([]),

        nonce: bigint({ mode: "bigint" }),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("message_channel_id_idx").on(table.channelId),
        index("message_created_at_idx").on(table.createdAt),
        index("message_channel_created_at_idx").on(
            table.channelId,
            table.createdAt,
        ),
    ],
);

export const messageRelations = relations(messagesTable, ({ one }) => ({
    space: one(spacesTable, {
        fields: [messagesTable.spaceId],
        references: [spacesTable.id],
    }),
    channel: one(channelsTable, {
        fields: [messagesTable.channelId],
        references: [channelsTable.id],
    }),
    author: one(usersTable, {
        fields: [messagesTable.authorId],
        references: [usersTable.id],
    }),
}));
