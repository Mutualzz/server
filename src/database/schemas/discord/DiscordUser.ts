import { bigint, date, integer, pgTable } from "drizzle-orm/pg-core";

export const discordUsersTable = pgTable("discord_users", {
    id: bigint({ mode: "bigint" }).primaryKey(),
    birthday: date({ mode: "date" }),
    utcOffsetMinutes: integer(),
});
