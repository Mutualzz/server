import { Precondition } from "@sapphire/framework";
import type {
    CommandInteraction,
    ContextMenuCommandInteraction,
    Message,
} from "discord.js";

export class OwnerOnlyPrecondition extends Precondition {
    public override messageRun = async (message: Message) =>
        this.checkOwner(message.author.id);

    public override chatInputRun = async (interaction: CommandInteraction) =>
        this.checkOwner(interaction.user.id);

    public override contextMenuRun = async (
        interaction: ContextMenuCommandInteraction,
    ) => this.checkOwner(interaction.user.id);

    private checkOwner = async (userId: string) =>
        userId === this.container.client.owner
            ? this.ok()
            : this.error({
                  message: "This command is restricted to the owner.",
              });
}
