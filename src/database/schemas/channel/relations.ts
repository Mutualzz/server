import { relations } from "drizzle-orm";
import { channelPermissionOverwritesTable } from "./ChannelPermissionOverwrite";
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
    overwrites: many(channelPermissionOverwritesTable),
}));

export const channelOverwriteRelations = relations(
    channelPermissionOverwritesTable,
    ({ one }) => ({
        channel: one(channelsTable, {
            fields: [channelPermissionOverwritesTable.channelId],
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
