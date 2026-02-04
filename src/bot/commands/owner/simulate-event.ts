import { StringOption } from "bot/Builders";
import { AbstractSlashCommand, SlashCommand } from "../../classes/SlashCommand";
import type { ChatInputCommandInteraction } from "discord.js";
import { type EVENTS } from "../../Constants";

@SlashCommand({
    name: "simulate-event",
    description: "Simulate an event (Owner Only)",
    preconditions: ["OwnerOnly"],
    requiredUserPermissions: ["Administrator"],
    opts: [
        new StringOption()
            .setName("event")
            .setDescription("The event to simulate")
            .setRequired(true)
            .setAutocomplete(true),
    ],
})
export default class SimulateEventCommand extends AbstractSlashCommand {
    async chatInputRun(interaction: ChatInputCommandInteraction) {
        if (!interaction.inCachedGuild()) return;
        const event = interaction.options.getString(
            "event",
            true,
        ) as keyof typeof EVENTS;

        // NOTE: For now we will only simulate needed events
        switch (event) {
            case "guildMemberAdd":
            case "guildMemberAvailable":
            case "guildMemberRemove":
            case "guildMemberBoost":
            case "guildMemberUnboost":
            case "guildMemberEntered": {
                const member = interaction.member;

                this.container.client.emit(event, member);
                await interaction.reply({
                    content: `Simulated event: ${event}`,
                    ephemeral: true,
                });
                break;
            }
            case "guildMemberOnline":
            case "guildMemberOffline": {
                const member = interaction.member;
                const newStatus =
                    event === "guildMemberOnline" ? "online" : "offline";

                this.container.client.emit(event, member, newStatus);
                await interaction.reply({
                    content: `Simulated event: ${event}`,
                    ephemeral: true,
                });
                break;
            }
            case "ready":
            case "clientReady": {
                await interaction.reply({
                    content: "Cannot use that",
                    ephemeral: true,
                });
                break;
            }
            default: {
                await interaction.reply({
                    content: `Event not supported for simulation: ${event} *yet*`,
                    ephemeral: true,
                });
                break;
            }
        }
    }
}
