import { relations } from "drizzle-orm";
import {
    bigint,
    index,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const changelogsTable = pgTable(
    "changelogs",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        title: text().notNull(),
        body: text().notNull(),
        imageUrl: text(),

        authorId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        desktopVersion: text(),
        mobileVersion: text(),

        publishedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("changelog_author_id_idx").on(table.authorId),
        index("changelog_published_at_idx").on(table.publishedAt),
        index("changelog_desktop_version_idx").on(table.desktopVersion),
        index("changelog_mobile_version_idx").on(table.mobileVersion),
    ],
);

export const changelogRelations = relations(changelogsTable, ({ one }) => ({
    author: one(usersTable, {
        fields: [changelogsTable.authorId],
        references: [usersTable.id],
    }),
}));
