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
import { spacesTable } from "./spaces/Space";
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
    fontFamily?: string | null;
    colors: {
        primary: string;
        secondary: string;
        accent: string;
        muted: string;
    };
}

interface ThemeWallpaper {
    brightness?: number;
    saturation?: number;
    overlay?: number;
    chrome?: number;
    content?: number;
    card?: number;
    popout?: number;
    composer?: number;
    blur?: number;
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

        spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
            onDelete: "cascade",
        }),

        type: themeTypeEnum().notNull(),
        style: themeStyleEnum().notNull(),
        adaptive: boolean().notNull(),

        colors: jsonb().$type<ThemeColors>().notNull(),
        typography: jsonb().$type<ThemeTypography>().notNull(),

        backgroundImage: text(),
        wallpaper: jsonb().$type<ThemeWallpaper>(),

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
        index("theme_space_id_idx").on(table.spaceId),
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
    space: one(spacesTable, {
        fields: [themesTable.spaceId],
        references: [spacesTable.id],
    }),
}));
