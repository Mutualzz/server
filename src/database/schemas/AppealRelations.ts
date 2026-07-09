import { relations } from "drizzle-orm";
import { usersTable } from "./users/User";
import { appealsTable } from "./Appeal";

export const appealRelations = relations(appealsTable, ({ one }) => ({
    user: one(usersTable, {
        fields: [appealsTable.userId],
        references: [usersTable.id],
        relationName: "appealUser",
    }),
    reviewedBy: one(usersTable, {
        fields: [appealsTable.reviewedById],
        references: [usersTable.id],
        relationName: "appealReviewedBy",
    }),
}));
