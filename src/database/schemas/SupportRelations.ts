import { relations } from "drizzle-orm";
import { usersTable } from "./users/User";
import { supportTicketsTable } from "./SupportTicket";
import { supportMessagesTable } from "./SupportMessage";

export const supportTicketRelations = relations(
    supportTicketsTable,
    ({ one, many }) => ({
        user: one(usersTable, {
            fields: [supportTicketsTable.userId],
            references: [usersTable.id],
            relationName: "supportTicketUser",
        }),
        assignedTo: one(usersTable, {
            fields: [supportTicketsTable.assignedToId],
            references: [usersTable.id],
            relationName: "supportTicketAssignee",
        }),
        messages: many(supportMessagesTable),
    }),
);

export const supportMessageRelations = relations(
    supportMessagesTable,
    ({ one }) => ({
        ticket: one(supportTicketsTable, {
            fields: [supportMessagesTable.ticketId],
            references: [supportTicketsTable.id],
        }),
        author: one(usersTable, {
            fields: [supportMessagesTable.authorId],
            references: [usersTable.id],
            relationName: "supportMessageAuthor",
        }),
    }),
);
