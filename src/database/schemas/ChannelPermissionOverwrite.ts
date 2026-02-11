import { bigint, pgTable } from "drizzle-orm/pg-core";

// TODO: Continue here
export const channelPermissionOverwritesTable = pgTable(
    "channel_permission_overwrites",
    {
        channelId: bigint({}),
    },
);
