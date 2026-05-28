import {
    bigint,
    boolean,
    index,
    pgTable,
    primaryKey,
    timestamp,
} from "drizzle-orm/pg-core";
import { channelsTable } from "./Channel";
import { usersTable } from "../users/User";

export const channelRecipientsTable = pgTable(
    "channel_recipients",
    {
        channelId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => channelsTable.id, { onDelete: "cascade" }),

        userId: bigint({
            mode: "bigint",
        })
            .notNull()
            .references(() => usersTable.id, { onDelete: "cascade" }),

        closed: boolean().notNull().default(false),

        createdAt: timestamp({ withTimezone: true, mode: "date" })
            .notNull()
            .defaultNow(),

        updatedAt: timestamp({ withTimezone: true, mode: "date" })
            .defaultNow()
            .notNull()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        primaryKey({ columns: [table.channelId, table.userId] }),
        index("cr_channel_id_idx").on(table.channelId),
        index("cr_user_id_idx").on(table.userId),
        index("cr_closed_idx").on(table.userId, table.closed),
    ],
);
