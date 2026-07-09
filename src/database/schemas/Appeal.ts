import type { AppealStatus } from "@mutualzz/types";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";

export const appealsTable = pgTable(
    "appeals",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        message: text().notNull(),

        status: text().notNull().default("pending").$type<AppealStatus>(),
        staffResponse: text(),

        reviewedById: bigint({ mode: "bigint" }).references(
            () => usersTable.id,
            { onDelete: "set null", onUpdate: "cascade" },
        ),
        reviewedAt: timestamp(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => [
        index("appeal_user_id_idx").on(t.userId),
        index("appeal_status_idx").on(t.status),
    ],
);
