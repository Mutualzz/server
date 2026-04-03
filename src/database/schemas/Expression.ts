import {
    bigint,
    boolean,
    index,
    pgTable,
    smallint,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { spacesTable, usersTable } from "@mutualzz/database";
import { relations, sql } from "drizzle-orm";

// Expression Type
// 0 - Emoji
// 1 - Sticker

// If spaceId set the expression belongs to a space
// Otherwise is it belongs to a user
// AuthorId is when set
export const expressionsTable = pgTable(
    "emojis",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        type: smallint().notNull(),

        name: text().notNull(),
        assetHash: text().notNull(),

        authorId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
            }),

        spaceId: bigint({
            mode: "bigint",
        }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        animated: boolean().notNull(),

        flags: bigint({ mode: "bigint" })
            .notNull()
            .default(sql`0`),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        index("expression_space_id_idx").on(table.spaceId),
        index("expression_author_id_idx").on(table.authorId),
        index("expression_type_idx").on(table.type),
        index("expression_animated_idx").on(table.animated),
    ],
);

export const expressionRelations = relations(expressionsTable, ({ one }) => ({
    user: one(usersTable, {
        fields: [expressionsTable.authorId],
        references: [usersTable.id],
    }),
    space: one(spacesTable, {
        fields: [expressionsTable.spaceId],
        references: [spacesTable.id],
    }),
}));
