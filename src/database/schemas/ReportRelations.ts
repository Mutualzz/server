import { relations } from "drizzle-orm";
import { usersTable } from "./users/User";
import { reportsTable } from "./Report";

export const reportRelations = relations(reportsTable, ({ one }) => ({
    reporter: one(usersTable, {
        fields: [reportsTable.reporterId],
        references: [usersTable.id],
        relationName: "reportReporter",
    }),
    reviewedBy: one(usersTable, {
        fields: [reportsTable.reviewedById],
        references: [usersTable.id],
        relationName: "reportReviewedBy",
    }),
}));
