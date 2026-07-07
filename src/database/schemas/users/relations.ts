import { relations } from "drizzle-orm";
import { usersTable } from "./User";
import { staffActionsTable } from "./StaffAction";

export const staffActionRelations = relations(
    staffActionsTable,
    ({ one }) => ({
        actor: one(usersTable, {
            fields: [staffActionsTable.actorId],
            references: [usersTable.id],
            relationName: "staffActionActor",
        }),
        target: one(usersTable, {
            fields: [staffActionsTable.targetId],
            references: [usersTable.id],
            relationName: "staffActionTarget",
        }),
    }),
);
