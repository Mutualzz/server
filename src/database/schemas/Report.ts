import type { ReportReason, ReportStatus, ReportTargetType } from "@mutualzz/types";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";

export const reportsTable = pgTable(
    "reports",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        reporterId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        // Polymorphic target — no FK, since it can point at messages,
        // posts, post comments, or users depending on targetType.
        targetType: text().notNull().$type<ReportTargetType>(),
        targetId: bigint({ mode: "bigint" }).notNull(),

        reason: text().notNull().$type<ReportReason>(),
        description: text(),

        status: text().notNull().default("pending").$type<ReportStatus>(),

        reviewedById: bigint({ mode: "bigint" }).references(
            () => usersTable.id,
            { onDelete: "set null", onUpdate: "cascade" },
        ),
        reviewedAt: timestamp(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => [
        index("report_target_idx").on(t.targetType, t.targetId),
        index("report_status_idx").on(t.status),
    ],
);
