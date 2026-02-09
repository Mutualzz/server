import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const discordUsersTable = pgTable("discord_users", {
    id: bigint({ mode: "bigint" }).primaryKey(),
    birthday: text(),
    birthdayMessage: bigint({ mode: "bigint" }),
});
