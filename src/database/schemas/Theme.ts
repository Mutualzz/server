import { relations } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const themeTypeEnum = pgEnum("theme_type", ["light", "dark"]);
export const themeStyleEnum = pgEnum("theme_style", ["normal", "gradient"]);

interface ThemeColors {
    common: {
        white: string;
        black: string;
    };
    primary: string;
    neutral: string;
    background: string;
    surface: string;
    danger: string;
    warning: string;
    info: string;
    success: string;
}

interface ThemeTypography {
    colors: {
        primary: string;
        secondary: string;
        accent: string;
        muted: string;
    };
}

export const themesTable = pgTable(
    "themes",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        name: text().notNull(),
        description: text(),

        authorId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        type: themeTypeEnum().notNull(),
        style: themeStyleEnum().notNull(),
        adaptive: boolean().notNull(),

        colors: jsonb().$type<ThemeColors>().notNull(),
        typography: jsonb().$type<ThemeTypography>().notNull(),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("theme_author_id_idx").on(table.authorId),
        index("theme_type_idx").on(table.type),
        index("theme_style_idx").on(table.style),
        index("theme_created_at_idx").on(table.createdAt),
    ],
);

export const themeRelations = relations(themesTable, ({ one }) => ({
    author: one(usersTable, {
        fields: [themesTable.authorId],
        references: [usersTable.id],
    }),
}));
