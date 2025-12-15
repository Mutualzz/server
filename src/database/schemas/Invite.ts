import { relations } from "drizzle-orm";
import {
    bigint,
    index,
    pgTable,
    smallint,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./Channel";
import { spacesTable } from "./spaces/Space";
import { usersTable } from "./users";

// Enums for invite types
// 0. Space Invite
// 1. Friend Invite
// More types can be added later

export const invitesTable = pgTable(
    "invites",
    {
        type: smallint().notNull(),

        code: text().notNull().primaryKey().unique(),

        // Not null only for space invites
        spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        // Not null only for space invites
        channelId: bigint({ mode: "bigint" }).references(
            () => channelsTable.id,
            {
                onDelete: "cascade",
            },
        ),

        // Not null only for friend invites
        userId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
            onDelete: "cascade",
        }),

        // Inviter
        inviterId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
            }),

        maxUses: smallint().notNull().default(0),
        uses: smallint().notNull().default(0),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),

        expiresAt: timestamp({ withTimezone: true, mode: "date" }),
    },
    (table) => [
        index("invite_code_idx").on(table.code),
        index("invite_type_idx").on(table.type),
        index("invite_space_id_idx").on(table.spaceId),
        index("invite_channel_id_idx").on(table.channelId),
        index("invite_user_id_idx").on(table.userId),
        index("invite_inviter_id_idx").on(table.inviterId),
        index("idx_invites_reuse").on(
            table.spaceId,
            table.channelId,
            table.createdAt.desc(),
        ),
    ],
);

export const inviteRelations = relations(invitesTable, ({ one }) => ({
    space: one(spacesTable, {
        fields: [invitesTable.spaceId],
        references: [spacesTable.id],
    }),
    channel: one(channelsTable, {
        fields: [invitesTable.channelId],
        references: [channelsTable.id],
    }),
    user: one(usersTable, {
        fields: [invitesTable.userId],
        references: [usersTable.id],
    }),
    inviter: one(usersTable, {
        fields: [invitesTable.inviterId],
        references: [usersTable.id],
    }),
}));
