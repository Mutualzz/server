import type {
    SupportTicketCategory,
    SupportTicketStatus,
} from "@mutualzz/types";
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";

export const supportTicketsTable = pgTable(
    "support_tickets",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        category: text().notNull().$type<SupportTicketCategory>(),
        subject: text().notNull(),
        status: text()
            .notNull()
            .default("open")
            .$type<SupportTicketStatus>(),

        platform: text(),
        appVersion: text(),

        assignedToId: bigint({ mode: "bigint" }).references(
            () => usersTable.id,
            { onDelete: "set null", onUpdate: "cascade" },
        ),

        lastMessageAt: timestamp().notNull().defaultNow(),
        createdAt: timestamp().notNull().defaultNow(),
        closedAt: timestamp(),
    },
    (t) => [
        index("support_ticket_user_id_idx").on(t.userId),
        index("support_ticket_status_idx").on(t.status),
        index("support_ticket_last_message_at_idx").on(t.lastMessageAt),
    ],
);
