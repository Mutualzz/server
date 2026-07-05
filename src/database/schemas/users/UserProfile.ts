import { relations } from "drizzle-orm";
import {
    bigint,
    boolean,
    jsonb,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import type {
    APIMobileProfileBlock,
    APIProfileBlock,
    APIProfileMusic,
} from "@mutualzz/types";
import { usersTable } from "./User";

export const userProfilesTable = pgTable("user_profiles", {
    userId: bigint({ mode: "bigint" })
        .primaryKey()
        .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),

    configured: boolean().notNull().default(false),

    backgroundColor: text(),
    backgroundImage: text(),
    banner: text(),
    bio: text(),
    pageFontFamily: text(),

    profileMusic: jsonb().$type<APIProfileMusic | null>(),

    blocks: jsonb().$type<APIProfileBlock[]>().notNull().default([]),

    mobileBlocks: jsonb()
        .$type<APIMobileProfileBlock[]>()
        .notNull()
        .default([]),

    updatedAt: timestamp({ withTimezone: true, mode: "date" })
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
});

export const userProfileRelations = relations(userProfilesTable, ({ one }) => ({
    user: one(usersTable, {
        fields: [userProfilesTable.userId],
        references: [usersTable.id],
    }),
}));
