import { db, discordUsersTable } from "@mutualzz/database";
import {
    InteractionHandler,
    InteractionHandlerTypes,
} from "@sapphire/framework";
import {
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    LabelBuilder,
    ModalBuilder,
    time,
} from "discord.js";
import { eq } from "drizzle-orm";
import dayjs from "dayjs";

export default class BirthdaysButtonHandler extends InteractionHandler {
    constructor(
        context: InteractionHandler.LoaderContext,
        options: InteractionHandler.Options,
    ) {
        super(context, {
            ...options,
            interactionHandlerType: InteractionHandlerTypes.Button,
        });
    }

    async run(interaction: ButtonInteraction) {
        if (
            !["add_birthday", "remove_birthday", "view_birthday"].includes(
                interaction.customId,
            )
        )
            return;

        if (!interaction.inCachedGuild()) return;

        let dbUser = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(interaction.user.id)),
        });

        if (!dbUser)
            dbUser = await db
                .insert(discordUsersTable)
                .values({
                    id: BigInt(interaction.user.id),
                })
                .returning()
                .then((r) => r[0]);

        if (!dbUser)
            return interaction.reply({
                content: "An error occurred while accessing your data.",
                flags: "Ephemeral",
            });

        if (
            (interaction.customId === "remove_birthday" ||
                interaction.customId === "view_birthday") &&
            !dbUser.birthday
        )
            return interaction.reply({
                content: "You don't have a birthday set",
                flags: "Ephemeral",
            });

        if (interaction.customId === "remove_birthday") {
            const channel = interaction.client.metadata.channels.birthdays;
            if (!channel?.isSendable()) return;

            if (dbUser.birthdayMessage) {
                const message = await channel.messages
                    .fetch(dbUser.birthdayMessage.toString())
                    .catch(() => null);

                if (message) await message.delete();
            }

            return Promise.all([
                db
                    .update(discordUsersTable)
                    .set({ birthday: null, birthdayMessage: null })
                    .where(
                        eq(discordUsersTable.id, BigInt(interaction.user.id)),
                    ),
                interaction.reply({
                    content: "Your birthday has been removed",
                    flags: "Ephemeral",
                }),
            ]);
        }

        if (interaction.customId === "view_birthday") {
            const birthdayDate = dayjs(dbUser.birthday, "MM/DD");

            return interaction.reply({
                content: `Your birthday is **${birthdayDate.format("MMMM D")}** | ${time(birthdayDate.toDate(), "R")} *(${birthdayDate.format("MM/DD")})*`,
                flags: "Ephemeral",
            });
        }

        const modal = new ModalBuilder()
            .setCustomId("set_birthday_modal")
            .setTitle("Add Your Birthday")
            .setLabelComponents(
                new LabelBuilder()
                    .setLabel("Enter your birthday")
                    .setDescription(
                        "It can be any format, e.g., MM/DD, DD/MM, etc.",
                    )
                    .setTextInputComponent(
                        new TextInputBuilder()
                            .setCustomId("birthday_input")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ),
            );

        await interaction.showModal(modal);

        const mInteraction = await interaction.awaitModalSubmit({
            time: 15 * 60 * 1000,
            filter: (i) =>
                i.customId === "set_birthday_modal" &&
                i.user.id === interaction.user.id,
        });

        const birthdayInput = mInteraction.fields
            .getTextInputValue("birthday_input")
            .trim()
            .replace(/[-. ]/g, "/");

        let birthdayDate = dayjs(
            birthdayInput,
            ["MM/DD/YYYY", "DD/MM/YYYY", "MM/DD", "DD/MM"],
            true,
        );

        if (!birthdayDate.isValid())
            birthdayDate = dayjs(birthdayInput, ["MM/DD", "DD/MM"], true);

        if (!birthdayDate.isValid())
            return mInteraction.reply({
                content: "Invalid date format. Please try again.",
                flags: "Ephemeral",
            });

        await db
            .update(discordUsersTable)
            .set({
                birthday: birthdayDate.format("MM/DD"),
            })
            .where(eq(discordUsersTable.id, BigInt(interaction.user.id)));

        await mInteraction.reply({
            content: `Your birthday has been set to **${birthdayDate.format("MMMM D")}** | ${time(birthdayDate.toDate(), "R")} *(${birthdayDate.format("MM/DD")})*`,
            flags: "Ephemeral",
        });

        const channel = interaction.client.metadata.channels.birthdays;

        if (!channel?.isSendable()) return;

        const message = await channel.send(
            `${interaction.user}'s birthday: **${birthdayDate.format("MMMM D")}** | ${time(birthdayDate.toDate(), "R")} *(${birthdayDate.format("MM/DD")})*`,
        );

        await db
            .update(discordUsersTable)
            .set({ birthdayMessage: BigInt(message.id) })
            .where(eq(discordUsersTable.id, BigInt(interaction.user.id)));
    }
}
