import { relations } from "drizzle-orm";
import { channelMemberOverwritesTable, channelRoleOverwritesTable, } from "./ChannelPermissionOverwrite";
import { channelRecipientsTable } from "./ChannelRecipient";
import { channelsTable } from "./Channel";
import { messagesTable } from "../Message";
import { spacesTable } from "../spaces";
import { usersTable } from "../users";

export const channelRelations = relations(channelsTable, ({ one, many }) => ({
  space: one(spacesTable, {
    fields: [channelsTable.spaceId],
    references: [spacesTable.id],
  }),
  owner: one(usersTable, {
    fields: [channelsTable.ownerId],
    references: [usersTable.id],
  }),
  parent: one(channelsTable, {
    fields: [channelsTable.parentId],
    references: [channelsTable.id],
  }),
  recipients: many(channelRecipientsTable),
  messages: many(messagesTable),
  roleOverwrites: many(channelRoleOverwritesTable),
  memberOverwrites: many(channelMemberOverwritesTable),
}));

export const channelRoleOverwriteRelations = relations(
  channelRoleOverwritesTable,
  ({ one }) => ({
    channel: one(channelsTable, {
      fields: [channelRoleOverwritesTable.channelId],
      references: [channelsTable.id],
    }),
  }),
);

export const channelMemberOverwriteRelations = relations(
  channelMemberOverwritesTable,
  ({ one }) => ({
    channel: one(channelsTable, {
      fields: [channelMemberOverwritesTable.channelId],
      references: [channelsTable.id],
    }),
  }),
);

export const channelRecipientRelations = relations(
  channelRecipientsTable,
  ({ one }) => ({
    channel: one(channelsTable, {
      fields: [channelRecipientsTable.channelId],
      references: [channelsTable.id],
    }),
    user: one(usersTable, {
      fields: [channelRecipientsTable.userId],
      references: [usersTable.id],
    }),
  }),
);
