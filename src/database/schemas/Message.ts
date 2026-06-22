import { usersTable } from "./users/User";
import type { APIMessageEmbed, APIMessageMention } from "@mutualzz/types";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./channel/Channel.ts";
import { spacesTable } from "./spaces";
import { messageReactionsTable } from "./MessageReaction";

export const messagesTable = pgTable(
  "messages",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    type: smallint().notNull().default(0),

    authorId: bigint({ mode: "bigint" }).references(() => usersTable.id, {
      onDelete: "set null",
    }),
    channelId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => channelsTable.id, {
        onDelete: "cascade",
      }),

    spaceId: bigint({ mode: "bigint" }).references(() => spacesTable.id, {
      onDelete: "cascade",
    }),

    content: text(),

    edited: boolean().default(false).notNull(),

    flags: bigint("flags", { mode: "bigint" })
      .notNull()
      .default(sql`0`),

    embeds: jsonb().$type<APIMessageEmbed[]>().notNull().default([]),
    expressionIds: bigint({ mode: "bigint" }).array().default([]).notNull(),

    repliedToId: bigint({ mode: "bigint" }).references(
      (): AnyPgColumn => messagesTable.id,
      {
        onDelete: "set null",
      },
    ),

    nonce: bigint({ mode: "bigint" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),

    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),

    mentions: jsonb().$type<APIMessageMention[]>().notNull().default([]),
  },
  (table) => [
    index("message_channel_id_idx").on(table.channelId),
    index("message_created_at_idx").on(table.createdAt),
    index("message_channel_created_at_idx").on(
      table.channelId,
      table.createdAt,
    ),
  ],
);

export const messageRelations = relations(messagesTable, ({ one, many }) => ({
  space: one(spacesTable, {
    fields: [messagesTable.spaceId],
    references: [spacesTable.id],
  }),
  channel: one(channelsTable, {
    fields: [messagesTable.channelId],
    references: [channelsTable.id],
  }),
  author: one(usersTable, {
    fields: [messagesTable.authorId],
    references: [usersTable.id],
  }),
  repliedTo: one(messagesTable, {
    fields: [messagesTable.repliedToId],
    references: [messagesTable.id],
  }),
  reactions: many(messageReactionsTable),
}));
