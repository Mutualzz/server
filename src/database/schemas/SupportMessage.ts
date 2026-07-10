import { bigint, boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users/User";
import { supportTicketsTable } from "./SupportTicket";

export const supportMessagesTable = pgTable(
    "support_messages",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),

        ticketId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => supportTicketsTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        authorId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),

        body: text().notNull(),
        isStaff: boolean().notNull(),

        createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => [index("support_message_ticket_id_idx").on(t.ticketId)],
);
