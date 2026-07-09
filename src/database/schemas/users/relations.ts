import { relations } from "drizzle-orm";
import { usersTable } from "./User";
import { staffActionsTable } from "./StaffAction";
import { staffNotesTable } from "./StaffNote";

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

export const staffNoteRelations = relations(staffNotesTable, ({ one }) => ({
    author: one(usersTable, {
        fields: [staffNotesTable.authorId],
        references: [usersTable.id],
        relationName: "staffNoteAuthor",
    }),
    target: one(usersTable, {
        fields: [staffNotesTable.targetId],
        references: [usersTable.id],
        relationName: "staffNoteTarget",
    }),
}));
