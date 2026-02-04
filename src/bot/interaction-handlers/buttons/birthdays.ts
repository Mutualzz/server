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

        const modal = new ModalBuilder()
            .setCustomId("set_birthday_modal")
            .setTitle("Add Your Birthday")
            .setLabelComponents(
                new LabelBuilder()
                    .setLabel("Enter your birthday")
                    .setDescription(
                        "It can be any format, e.g., YYYY-MM-DD or even very specific with hours and minutes",
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
    }
}
