import { sql } from "drizzle-orm";
import {
    bigint,
    date,
    pgEnum,
    pgTable,
    text,
    timestamp,
} from "drizzle-orm/pg-core";

export const defaultAvatarEnum = pgEnum("default_avatar", [
    "cat",
    "dog",
    "dragon",
    "fox",
    "hyena",
    "rabbit",
    "raccoon",
    "wolf",
]);

export const usersTable = pgTable("users", {
    id: text().primaryKey().notNull(),
    username: text().notNull().unique(),
    email: text().notNull().unique(),
    accentColor: text().notNull(),
    globalName: text(),

    defaultAvatar: defaultAvatarEnum().notNull(),
    avatar: text(),
    previousAvatars: text().array().default([]).notNull(),

    dateOfBirth: date().notNull(),

    hash: text().notNull(),

    flags: bigint("flags", { mode: "bigint" })
        .notNull()
        .default(sql`0`),

    created: timestamp().notNull().defaultNow(),
    updated: timestamp()
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
});

export const toPublicUser = (user: typeof usersTable.$inferSelect) => {
    const { hash, previousAvatars, email, ...publicUser } = user;
    return publicUser;
};
