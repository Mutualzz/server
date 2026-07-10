import { relations } from "drizzle-orm";
import { spacesTable } from "./spaces/Space";
import { usersTable } from "./users/User";
import { appealsTable } from "./Appeal";

export const appealRelations = relations(appealsTable, ({ one }) => ({
    user: one(usersTable, {
        fields: [appealsTable.userId],
        references: [usersTable.id],
        relationName: "appealUser",
    }),
    space: one(spacesTable, {
        fields: [appealsTable.spaceId],
        references: [spacesTable.id],
    }),
    reviewedBy: one(usersTable, {
        fields: [appealsTable.reviewedById],
        references: [usersTable.id],
        relationName: "appealReviewedBy",
    }),
}));
