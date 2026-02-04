import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import type { GuildMember } from "discord.js";
import { eq } from "drizzle-orm";

export default class CheckUserDatabaseWithStatusListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            once: true,
            event: "guildMemberOnline",
            name: "check-user-database-with-status",
            description:
                "Emitted every time user comes online to check database.",
        });
    }

    async run(member: GuildMember, newStatus: string) {
        if (newStatus !== "online") return;

        const userExists = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(member.user.id)),
        });

        if (userExists) return;

        await db.insert(discordUsersTable).values({
            id: BigInt(member.user.id),
        });
    }
}
