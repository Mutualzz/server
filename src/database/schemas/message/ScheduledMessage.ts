import type {
  APIAttachment,
  APICodedLinkInput,
  ScheduledMessageStatus,
} from "@mutualzz/types";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "../channel/Channel";
import { usersTable } from "../users/User";

export const scheduledMessagesTable = pgTable(
  "scheduled_messages",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    authorId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channelId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => channelsTable.id, { onDelete: "cascade" }),

    content: text(),
    repliedToId: bigint({ mode: "bigint" }),
    mentionReply: boolean().notNull().default(true),
    expressionIds: bigint({ mode: "bigint" }).array().notNull().default([]),
    sharedPostId: bigint({ mode: "bigint" }),
    codedLinks: jsonb().$type<APICodedLinkInput[]>().notNull().default([]),
    attachments: jsonb().$type<APIAttachment[]>().notNull().default([]),

    scheduledFor: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    status: text().$type<ScheduledMessageStatus>().notNull().default("pending"),
    failureReason: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("scheduled_messages_author_scheduled_for_idx").on(
      table.authorId,
      table.scheduledFor,
    ),
    index("scheduled_messages_due_idx")
      .on(table.scheduledFor)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const scheduledMessageRelations = relations(
  scheduledMessagesTable,
  ({ one }) => ({
    author: one(usersTable, {
      fields: [scheduledMessagesTable.authorId],
      references: [usersTable.id],
    }),
    channel: one(channelsTable, {
      fields: [scheduledMessagesTable.channelId],
      references: [channelsTable.id],
    }),
  }),
);
