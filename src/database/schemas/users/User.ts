import type { APIPrivateUser } from "@mutualzz/types";
import { sql } from "drizzle-orm";
import {
    bigint,
    date,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";

interface DefaultAvatar {
    type: number;
    color?: string | null;
}

export const usersTable = pgTable(
    "users",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        username: text().notNull().unique(),
        email: text().notNull().unique(),
        accentColor: text().notNull(),
        globalName: text(),
        pronouns: text(),

        defaultAvatar: jsonb().$type<DefaultAvatar>().notNull(),
        avatar: text(),
        previousAvatars: text().array().default([]).notNull(),

        dateOfBirth: date().notNull(),

        hash: text().notNull(),

        flags: bigint("flags", { mode: "bigint" })
            .notNull()
            .default(sql`0`),

        restrictedUntil: timestamp(),
        restrictionReason: text(),

        createdAt: timestamp().notNull().defaultNow(),
        updatedAt: timestamp()
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [index("user_created_at_idx").on(table.createdAt)],
);

export const toPublicUser = (user: APIPrivateUser) => {
    if ("hash" in user) delete user.hash;
    const {
        dateOfBirth,
        previousAvatars,
        email,
        restrictedUntil,
        restrictionReason,
        ...publicUser
    } = user;
    return publicUser;
};
