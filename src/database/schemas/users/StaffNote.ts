import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const staffNotesTable = pgTable(
    "staff_notes",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        targetId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        authorId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        content: text().notNull(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => [index("staff_note_target_id_idx").on(t.targetId)],
);
