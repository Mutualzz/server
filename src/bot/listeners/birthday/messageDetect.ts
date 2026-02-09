import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import dayjs from "dayjs";
import { time, type Message } from "discord.js";
import { eq } from "drizzle-orm";

export default class BirthdayMessageDetectListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageCreate",
            name: "birthday-message-detect",
            description:
                "Detects messages in the birthday channel to send the birthday message.",
        });
    }

    async run(message: Message) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (message.author?.bot) return;
        const { client } = this.container;
        const { channel } = message;

        if (!channel.isSendable()) return;
        if (channel.id !== client.metadata.channels.birthdays?.id) return;

        await message.delete();

        const botMessage = await channel.send("Processing your birthday...");

        const birthdayInput = message.content.trim().replace(/[-. ]/g, "/");

        let birthdayDate = dayjs(
            birthdayInput,
            ["MM/DD/YYYY", "DD/MM/YYYY", "MM/DD", "DD/MM"],
            true,
        );

        if (!birthdayDate.isValid())
            birthdayDate = dayjs(birthdayInput, ["MM/DD", "DD/MM"], true);

        if (!birthdayDate.isValid())
            return botMessage
                .edit({
                    content: "Invalid date format. Please try again.",
                })
                .then((msg) => {
                    setTimeout(() => msg.delete(), 5000);
                });

        const dbUser = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(message.author.id)),
        });

        if (!dbUser)
            return botMessage
                .edit({
                    content: "An error occurred while accessing your data.",
                })
                .then((msg) => {
                    setTimeout(() => msg.delete(), 5000);
                });

        if (dbUser.birthday)
            return botMessage
                .edit({
                    content:
                        "You already have a birthday set. Please remove it first if you want to change it.",
                })
                .then((msg) => {
                    setTimeout(() => msg.delete(), 5000);
                });

        await db
            .update(discordUsersTable)
            .set({ birthday: birthdayDate.format("MM/DD") })
            .where(eq(discordUsersTable.id, BigInt(message.author.id)));

        await botMessage
            .edit({
                content: `Your birthday has been set to **${birthdayDate.format("MMMM D")}** | ${time(birthdayDate.toDate(), "R")} *(${birthdayDate.format("MM/DD")})*`,
            })
            .then((msg) => {
                setTimeout(() => msg.delete(), 1000);
            });

        const newMessage = await channel.send(
            `${message.author}'s birthday: **${birthdayDate.format("MMMM D")}** | ${time(birthdayDate.toDate(), "R")} *(${birthdayDate.format("MM/DD")})*`,
        );

        await db
            .update(discordUsersTable)
            .set({ birthdayMessage: BigInt(newMessage.id) })
            .where(eq(discordUsersTable.id, BigInt(message.author.id)));
    }
}
