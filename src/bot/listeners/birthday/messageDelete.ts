import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import type { Message } from "discord.js";
import { eq } from "drizzle-orm";

export default class BirthdayMessageDeleteListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageDelete",
            name: "birthday-message-delete",
            description:
                "Automanage birthday on the backend when the message is deleted",
        });
    }

    async run(message: Message) {
        if (!message.inGuild()) return;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!message.author) return;
        if (!message.author.bot) return;
        const { client } = this.container;
        const { channel } = message;

        if (!channel.isSendable()) return;
        if (channel.id !== client.metadata.channels.birthdays?.id) return;

        const mentions = message.mentions.users;
        if (mentions.size === 0) return;

        const mentionedUser = mentions.first();
        if (!mentionedUser) return;

        const dbUser = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(mentionedUser.id)),
        });

        if (!dbUser || !dbUser.birthday) return;

        await db
            .update(discordUsersTable)
            .set({ birthdayMessage: null, birthday: null })
            .where(eq(discordUsersTable.id, BigInt(dbUser.id)));

        await channel
            .send({
                content: `Birthday message for ${mentionedUser} was deleted, birthday has been removed. Sad to see you go!`,
                allowedMentions: { users: [] },
            })
            .then((msg) => {
                setTimeout(() => msg.delete(), 5000);
            });
    }
}
