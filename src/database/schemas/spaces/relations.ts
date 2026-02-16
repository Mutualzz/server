import { relations } from "drizzle-orm";
import { channelsTable } from "../Channel";
import { usersTable } from "../users";
import { rolesTable } from "./Role";
import { spacesTable } from "./Space";
import { spaceMembersTable } from "./SpaceMember";
import { spaceMemberRolesTable } from "./SpaceMemberRoles";

export const spaceRelations = relations(spacesTable, ({ one, many }) => ({
    owner: one(usersTable, {
        fields: [spacesTable.ownerId],
        references: [usersTable.id],
    }),
    members: many(spaceMembersTable),
    channels: many(channelsTable),
    roles: many(rolesTable),
}));

export const spaceMemberRoleRelations = relations(
    spaceMemberRolesTable,
    ({ one }) => ({
        member: one(spaceMembersTable, {
            fields: [
                spaceMemberRolesTable.spaceId,
                spaceMemberRolesTable.userId,
            ],
            references: [spaceMembersTable.spaceId, spaceMembersTable.userId],
        }),
        role: one(rolesTable, {
            fields: [spaceMemberRolesTable.roleId],
            references: [rolesTable.id],
        }),
    }),
);

export const spaceMemberRelations = relations(
    spaceMembersTable,
    ({ one, many }) => ({
        user: one(usersTable, {
            fields: [spaceMembersTable.userId],
            references: [usersTable.id],
        }),
        space: one(spacesTable, {
            fields: [spaceMembersTable.spaceId],
            references: [spacesTable.id],
        }),
        roles: many(spaceMemberRolesTable),
    }),
);

export const roleRelations = relations(rolesTable, ({ one, many }) => ({
    space: one(spacesTable, {
        fields: [rolesTable.spaceId],
        references: [spacesTable.id],
    }),
    memberRoles: many(spaceMemberRolesTable),
}));
