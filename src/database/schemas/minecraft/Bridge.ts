import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { spacesTable } from "../spaces/Space";
import { usersTable } from "../users";

export const bridgesTable = pgTable(
  "bridges",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    spaceId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => spacesTable.id, { onDelete: "cascade" }),
    createdById: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    name: text().notNull(),
    status: smallint().notNull().default(0),
    lastMessageId: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("bridges_space_id_uq").on(table.spaceId),
    index("bridges_created_by_id_idx").on(table.createdById),
    index("bridge_status_idx").on(table.status),
  ],
);

export const bridgeTokensTable = pgTable(
  "bridge_tokens",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    tokenPrefix: text().notNull(),
    name: text().notNull().default("default"),
    lastUsedAt: timestamp({ withTimezone: true, mode: "date" }),
    revokedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bridge_token_bridge_id_idx").on(table.bridgeId),
    index("bridge_token_hash_idx").on(table.tokenHash),
  ],
);

export const bridgeMinecraftServersTable = pgTable(
  "bridge_minecraft_servers",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    serverId: text().notNull(),
    displayName: text().notNull(),
    lastSeenAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("bridge_mc_server_bridge_id_idx").on(table.bridgeId),
    index("bridge_mc_server_slug_idx").on(table.bridgeId, table.serverId),
  ],
);

export const bridgeDiscordBindingsTable = pgTable(
  "bridge_discord_bindings",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    serverId: text().notNull(),
    guildId: text().notNull(),
    channelId: text().notNull(),
    webhookId: text(),
    webhookToken: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("bridge_discord_binding_bridge_id_idx").on(table.bridgeId),
    index("bridge_discord_binding_channel_idx").on(table.channelId),
    index("bridge_discord_binding_server_idx").on(table.bridgeId, table.serverId),
  ],
);

export const bridgeVoiceBindingsTable = pgTable(
  "bridge_voice_bindings",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    serverId: text().notNull(),
    name: text().notNull().default("default"),
    spaceId: bigint({ mode: "bigint" }).notNull(),
    channelId: bigint({ mode: "bigint" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("bridge_voice_binding_bridge_id_idx").on(table.bridgeId),
    index("bridge_voice_binding_server_idx").on(table.bridgeId, table.serverId),
    index("bridge_voice_binding_room_idx").on(
      table.bridgeId,
      table.serverId,
      table.name,
    ),
  ],
);

export const bridgeMembersTable = pgTable(
  "bridge_members",
  {
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    joinedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.bridgeId, table.userId] }),
    index("bridge_member_user_id_idx").on(table.userId),
    index("bridge_member_bridge_id_idx").on(table.bridgeId),
  ],
);

export const bridgeReadStatesTable = pgTable(
  "bridge_read_states",
  {
    userId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    lastAckedId: text().notNull().default(""),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.bridgeId] }),
    index("bridge_read_state_bridge_id_idx").on(table.bridgeId),
  ],
);

export const bridgeMessagesTable = pgTable(
  "bridge_messages",
  {
    id: bigint({ mode: "bigint" }).primaryKey(),
    bridgeId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => bridgesTable.id, { onDelete: "cascade" }),
    sourceKey: text().notNull().unique(),
    serverId: text().notNull(),
    source: text().notNull(),
    kind: text().notNull().default("chat"),
    name: text().notNull(),
    content: text().notNull().default(""),
    uuid: text(),
    userId: text(),
    avatarUrl: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bridge_message_bridge_id_idx").on(table.bridgeId),
    index("bridge_message_bridge_created_at_idx").on(
      table.bridgeId,
      table.createdAt,
    ),
  ],
);

export const bridgeRelations = relations(bridgesTable, ({ one, many }) => ({
  space: one(spacesTable, {
    fields: [bridgesTable.spaceId],
    references: [spacesTable.id],
  }),
  createdBy: one(usersTable, {
    fields: [bridgesTable.createdById],
    references: [usersTable.id],
  }),
  tokens: many(bridgeTokensTable),
  servers: many(bridgeMinecraftServersTable),
  discordBindings: many(bridgeDiscordBindingsTable),
  voiceBindings: many(bridgeVoiceBindingsTable),
  members: many(bridgeMembersTable),
  messages: many(bridgeMessagesTable),
}));

export const bridgeTokenRelations = relations(bridgeTokensTable, ({ one }) => ({
  bridge: one(bridgesTable, {
    fields: [bridgeTokensTable.bridgeId],
    references: [bridgesTable.id],
  }),
}));

export const bridgeMinecraftServerRelations = relations(
  bridgeMinecraftServersTable,
  ({ one }) => ({
    bridge: one(bridgesTable, {
      fields: [bridgeMinecraftServersTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);

export const bridgeDiscordBindingRelations = relations(
  bridgeDiscordBindingsTable,
  ({ one }) => ({
    bridge: one(bridgesTable, {
      fields: [bridgeDiscordBindingsTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);

export const bridgeVoiceBindingRelations = relations(
  bridgeVoiceBindingsTable,
  ({ one }) => ({
    bridge: one(bridgesTable, {
      fields: [bridgeVoiceBindingsTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);

export const bridgeMemberRelations = relations(
  bridgeMembersTable,
  ({ one }) => ({
    bridge: one(bridgesTable, {
      fields: [bridgeMembersTable.bridgeId],
      references: [bridgesTable.id],
    }),
    user: one(usersTable, {
      fields: [bridgeMembersTable.userId],
      references: [usersTable.id],
    }),
  }),
);

export const bridgeReadStateRelations = relations(
  bridgeReadStatesTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [bridgeReadStatesTable.userId],
      references: [usersTable.id],
    }),
    bridge: one(bridgesTable, {
      fields: [bridgeReadStatesTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);

export const bridgeMessageRelations = relations(
  bridgeMessagesTable,
  ({ one }) => ({
    bridge: one(bridgesTable, {
      fields: [bridgeMessagesTable.bridgeId],
      references: [bridgesTable.id],
    }),
  }),
);
