import { db, discordUsersTable } from "@mutualzz/database";
import {
    InteractionHandler,
    InteractionHandlerTypes,
} from "@sapphire/framework";
import { TIMEZONES } from "../../Constants";
import {
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    LabelBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
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
            interaction.customId !== "remove_birthday" &&
            interaction.customId !== "add_birthday"
        )
            return;
        if (!interaction.inCachedGuild()) return;

        const dbUser = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(interaction.user.id)),
        });
        if (!dbUser) return;

        if (interaction.customId === "remove_birthday") {
            if (!dbUser.birthday) {
                await interaction.reply({
                    content: "You don't have a birthday set.",
                    ephemeral: true,
                });

                return;
            }

            await db
                .update(discordUsersTable)
                .set({ birthday: null })
                .where(eq(discordUsersTable.id, BigInt(interaction.user.id)));

            await interaction.reply({
                content: "Your birthday has been removed",
                ephemeral: true,
            });

            return;
        }

        if (dbUser.birthday) {
            await interaction.reply({
                content:
                    "You already have a birthday set. Please remove it first if you want to change it.",
                ephemeral: true,
            });

            return;
        }

        const modal = new ModalBuilder()
            .setCustomId("set_birthday_modal")
            .setTitle("Add Your Birthday")
            .setLabelComponents(
                new LabelBuilder()
                    .setLabel("Enter your birthday")
                    .setDescription(
                        "It can be any format, e.g., DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD, etc.",
                    )
                    .setTextInputComponent(
                        new TextInputBuilder()
                            .setCustomId("birthday_input")
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true),
                    ),
                new LabelBuilder()
                    .setLabel("Timezone")
                    .setDescription(
                        "You can also select your timezone (Optional)\nDefault is UTC+0",
                    )
                    .setStringSelectMenuComponent(
                        new StringSelectMenuBuilder()
                            .setCustomId("timezone_select")
                            .setPlaceholder("Select your timezone")
                            .setOptions(
                                TIMEZONES.map((tz) => ({
                                    label: tz.label,
                                    value: tz.value.toString(),
                                })),
                            )
                            .setMinValues(0)
                            .setMaxValues(1)
                            .setRequired(false),
                    ),
            );

        await interaction.showModal(modal);

        const mInteraction = await interaction.awaitModalSubmit({
            time: 15 * 60 * 1000,
            filter: (i) =>
                i.customId === "set_birthday_modal" &&
                i.user.id === interaction.user.id,
        });

        const birthdayInput =
            mInteraction.fields.getTextInputValue("birthday_input");
        const timezoneSelected =
            parseInt(
                mInteraction.fields.getStringSelectValues("timezone_select")[0],
            ) || 0;

        const birthdayDate = dayjs(birthdayInput, [
            "DD/MM/YYYY",
            "MM/DD/YYYY",
            "YYYY/MM/DD",
            "YYYY-MM-DD",
            "DD-MM-YYYY",
            "MM-DD-YYYY",
            "YYYY.MM.DD",
            "DD.MM.YYYY",
            "MM.DD.YYYY",
            "YYYY MM DD",
            "DD MM YYYY",
            "MM DD YYYY",
            "YYYY/MM/DD HH:mm",
            "DD/MM/YYYY HH:mm",
            "MM/DD/YYYY HH:mm",
            "YYYY-MM-DD HH:mm",
            "DD-MM-YYYY HH:mm",
            "MM-DD-YYYY HH:mm",
            "YYYY.MM.DD HH:mm",
            "DD.MM.YYYY HH:mm",
            "MM.DD.YYYY HH:mm",
            "YYYY MM DD HH:mm",
            "DD MM YYYY HH:mm",
            "MM DD YYYY HH:mm",
        ]).utcOffset(timezoneSelected);

        if (!birthdayDate.isValid()) {
            await mInteraction.reply({
                content: "Invalid date format. Please try again.",
                ephemeral: true,
            });
            return;
        }

        await db
            .update(discordUsersTable)
            .set({
                birthday: birthdayDate.toDate(),
                utcOffsetMinutes: timezoneSelected,
            })
            .where(eq(discordUsersTable.id, BigInt(interaction.user.id)));

        await mInteraction.reply({
            content: `Your birthday has been set to ${birthdayDate.format(
                "YYYY-MM-DD HH:mm",
            )} (UTC${timezoneSelected >= 0 ? "+" : ""}${timezoneSelected / 60})`,
            ephemeral: true,
        });
    }
}
