import { bigint, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const preferredModeEnum = pgEnum("preferred_mode", ["spaces", "feed"]);

export const userSettingsTable = pgTable("user_settings", {
    userId: bigint({ mode: "bigint" })
        .primaryKey()
        .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),

    currentTheme: text(),
    currentIcon: text(),

    preferredMode: preferredModeEnum().default("spaces").notNull(),

    spacePositions: bigint({ mode: "bigint" }).array().default([]).notNull(),

    updatedAt: timestamp()
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
});
