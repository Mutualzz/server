import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const preferredModeEnum = pgEnum("preferred_mode", ["spaces", "feed"]);

export const userSettingsTable = pgTable("user_settings", {
    user: text()
        .notNull()
        .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),

    currentTheme: text().default("baseDark").notNull(),

    preferredMode: preferredModeEnum().default("spaces").notNull(),

    spacePositions: text().array().default([]).notNull(),

    updated: timestamp()
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
});
