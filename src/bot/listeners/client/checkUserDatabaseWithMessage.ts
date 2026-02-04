import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import type { Message } from "discord.js";
import { eq } from "drizzle-orm";

export default class CheckUserDatabaseWithMessageListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            once: true,
            event: "messageCreate",
            name: "check-user-database-with-message",
            description: "Emitted every time user types a message.",
        });
    }

    async run(message: Message) {
        if (message.author.bot) return;
        if (!message.inGuild()) return;

        const userExists = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(message.author.id)),
        });

        if (userExists) return;

        await db.insert(discordUsersTable).values({
            id: BigInt(message.author.id),
        });
    }
}
