import {
    boolean,
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

export const themesTable = pgTable("themes", {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    description: text(),

    author: text()
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

    created: timestamp({ withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow(),

    updated: timestamp({ withTimezone: true, mode: "date" })
        .defaultNow()
        .notNull()
        .$onUpdate(() => new Date()),
});
