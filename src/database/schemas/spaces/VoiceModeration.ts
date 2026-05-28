import {
    bigint,
    boolean,
    index,
    pgTable,
    primaryKey,
    timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "../users";
import { spacesTable } from "./Space";

export const voiceModerationTable = pgTable(
    "voice_moderation",
    {
        spaceId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => spacesTable.id, {
                onDelete: "cascade",
            }),

        userId: bigint({ mode: "bigint" })
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
            }),

        spaceMute: boolean().notNull().default(false),
        spaceDeaf: boolean().notNull().default(false),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        primaryKey({ columns: [table.spaceId, table.userId] }),
        index("voice_moderation_space_id_idx").on(table.spaceId),
        index("voice_moderation_user_id_idx").on(table.userId),
    ],
);
