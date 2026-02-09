import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import dayjs from "dayjs";
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
        const user = message.author;
        if (user.bot) return;
        if (!message.inGuild()) return;

        const userExists = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(user.id)),
        });

        // TOOD: FInish the birthday system
        // where when a user deletes their birthday message
        // it gets removed from the database, since we stored it here.
        if (userExists) {
            user.birthday = dayjs(userExists.birthday).toDate();
            const birthdayMessage =
                await this.container.client.metadata.channels.birthdays?.messages
                    .fetch(userExists.birthdayMessage?.toString() ?? "")
                    .catch(() => undefined);

            if (birthdayMessage) user.birthdayMessage = birthdayMessage;

            return;
        }

        const newUser = await db
            .insert(discordUsersTable)
            .values({
                id: BigInt(user.id),
            })
            .returning()
            .then((r) => r[0]);

        user.birthday = dayjs(newUser.birthday).toDate();
    }
}
