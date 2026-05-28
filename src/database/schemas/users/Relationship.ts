import {
    bigint,
    index,
    pgTable,
    smallint,
    timestamp,
    uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const relationshipsTable = pgTable(
    "relationships",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),
        otherUserId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),

        type: smallint().notNull(),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        uniqueIndex("relationships_user_other_uq").on(
            table.userId,
            table.otherUserId,
        ),
        index("relationships_user_id_idx").on(table.userId),
        index("relationships_other_user_id_idx").on(table.otherUserId),
        index("relationships_type_idx").on(table.type),
    ],
);
