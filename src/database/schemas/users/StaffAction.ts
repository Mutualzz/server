import type { StaffActionType } from "@mutualzz/types";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./User";

export const staffActionsTable = pgTable(
    "staff_actions",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        actorId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        targetId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
                onDelete: "set null",
                onUpdate: "cascade",
            }),

        action: text().notNull().$type<StaffActionType>(),
        reason: text(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => [index("staff_action_target_id_idx").on(t.targetId)],
);
