import {
    bigint,
    pgTable,
    primaryKey,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users/User";
import { spacesTable } from "./Space";

export const spaceBansTable = pgTable(
    "space_bans",
    {
        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        bannedById: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        reason: text(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => ({
        pk: primaryKey({ columns: [t.spaceId, t.userId] }),
    }),
);
