import { relations } from "drizzle-orm";
import {
    bigint,
    index,
    pgTable,
    primaryKey,
    smallint,
    text,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";

/** 0 = active, 1 = archived/disabled */
export const bridgesTable = pgTable(
    "bridges",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        ownerId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),
        name: text().notNull(),
        status: smallint().notNull().default(0),
        /** Latest bridge feed sourceKey for unread comparisons */
        lastMessageId: text(),
        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("bridge_owner_id_idx").on(table.ownerId),
        index("bridge_status_idx").on(table.status),
    ],
);

export const bridgeRelations = relations(bridgesTable, ({ one, many }) => ({
    owner: one(usersTable, {
        fields: [bridgesTable.ownerId],
        references: [usersTable.id],
    }),
    tokens: many(bridgeTokensTable),
    servers: many(bridgeMinecraftServersTable),
    discordBindings: many(bridgeDiscordBindingsTable),
    voiceBindings: many(bridgeVoiceBindingsTable),
}));

export const bridgeTokensTable = pgTable(
    "bridge_tokens",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        bridgeId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => bridgesTable.id, { onDelete: "cascade" }),
        /** SHA-256 hex of the plaintext token. Plaintext is shown once at creation. */
        tokenHash: text().notNull().unique(),
        /** Short prefix for display, e.g. mz_bridge_ab12… */
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

export const bridgeTokenRelations = relations(bridgeTokensTable, ({ one }) => ({
    bridge: one(bridgesTable, {
        fields: [bridgeTokensTable.bridgeId],
        references: [bridgesTable.id],
    }),
}));

export const bridgeMinecraftServersTable = pgTable(
    "bridge_minecraft_servers",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        bridgeId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => bridgesTable.id, { onDelete: "cascade" }),
        /** Slug used in plugin config, e.g. smp / lobby */
        serverId: text().notNull(),
        displayName: text().notNull(),
        lastSeenAt: timestamp({ withTimezone: true, mode: "date" }),
        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        index("bridge_mc_server_bridge_id_idx").on(table.bridgeId),
        index("bridge_mc_server_slug_idx").on(table.bridgeId, table.serverId),
    ],
);

export const bridgeMinecraftServerRelations = relations(
    bridgeMinecraftServersTable,
    ({ one, many }) => ({
        bridge: one(bridgesTable, {
            fields: [bridgeMinecraftServersTable.bridgeId],
            references: [bridgesTable.id],
        }),
        discordBindings: many(bridgeDiscordBindingsTable),
    }),
);

export const bridgeDiscordBindingsTable = pgTable(
    "bridge_discord_bindings",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        bridgeId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => bridgesTable.id, { onDelete: "cascade" }),
        /** Matches bridge_minecraft_servers.serverId */
        serverId: text().notNull(),
        guildId: text().notNull(),
        channelId: text().notNull(),
        webhookId: text(),
        webhookToken: text(),
        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("bridge_discord_binding_bridge_id_idx").on(table.bridgeId),
        index("bridge_discord_binding_channel_idx").on(table.channelId),
        index("bridge_discord_binding_server_idx").on(
            table.bridgeId,
            table.serverId,
        ),
    ],
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

/**
 * Maps an MC server (slug) to a Mutualzz voice channel players can join from Minecraft.
 * `name` is the in-game room key used by `/mz voice join <name>` (default = "default").
 */
export const bridgeVoiceBindingsTable = pgTable(
    "bridge_voice_bindings",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        bridgeId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => bridgesTable.id, { onDelete: "cascade" }),
        /** Matches bridge_minecraft_servers.serverId */
        serverId: text().notNull(),
        /** In-game room key, e.g. default / lobby */
        name: text().notNull().default("default"),
        spaceId: bigint({ mode: "bigint" }).notNull(),
        channelId: bigint({ mode: "bigint" }).notNull(),
        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("bridge_voice_binding_bridge_id_idx").on(table.bridgeId),
        index("bridge_voice_binding_server_idx").on(
            table.bridgeId,
            table.serverId,
        ),
        index("bridge_voice_binding_room_idx").on(
            table.bridgeId,
            table.serverId,
            table.name,
        ),
        index("bridge_voice_binding_channel_idx").on(table.channelId),
    ],
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

/** Persisted bridge feed history (chat + join/leave). */
export const bridgeMessagesTable = pgTable(
    "bridge_messages",
    {
        id: bigint({ mode: "bigint" }).primaryKey(),
        bridgeId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => bridgesTable.id, { onDelete: "cascade" }),
        /** Client/gateway event id (sourceId) for dedupe across live + history */
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

export const bridgeMessageRelations = relations(
    bridgeMessagesTable,
    ({ one }) => ({
        bridge: one(bridgesTable, {
            fields: [bridgeMessagesTable.bridgeId],
            references: [bridgesTable.id],
        }),
    }),
);

/** Per-owner read cursor for bridge chat unreads. */
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
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.bridgeId] }),
        index("bridge_read_state_bridge_id_idx").on(table.bridgeId),
    ],
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
