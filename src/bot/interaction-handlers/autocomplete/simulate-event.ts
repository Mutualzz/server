import {
    InteractionHandler,
    InteractionHandlerTypes,
} from "@sapphire/framework";
import { EVENTS } from "../../Constants";
import type { AutocompleteInteraction } from "discord.js";

export default class SimulateEventAutocompleteHandler extends InteractionHandler {
    constructor(
        context: InteractionHandler.LoaderContext,
        options: InteractionHandler.Options,
    ) {
        super(context, {
            ...options,
            interactionHandlerType: InteractionHandlerTypes.Autocomplete,
        });
    }

    async run(interaction: AutocompleteInteraction) {
        if (!interaction.inCachedGuild()) return;

        const value = interaction.options.getFocused().toLowerCase();

        const choices = Object.values(EVENTS).filter((event) =>
            event.toLowerCase().includes(value),
        );

        await interaction.respond(
            choices
                .map((choice) => ({ name: choice, value: choice }))
                .splice(0, 25)
                .sort((a, b) => a.name.localeCompare(b.name)),
        );
    }
}
