import { ContextMenuCommandBuilder } from "@discordjs/builders";
import { Command } from "@sapphire/framework";
import {
    ApplicationCommandType,
    ApplicationIntegrationType,
    InteractionContextType,
} from "discord.js";

export abstract class AbstractMessageMenuCommand extends Command {
    readonly data: ContextMenuCommandBuilder;

    readonly contexts: InteractionContextType[];
    readonly integrations: ApplicationIntegrationType[];

    readonly type = ApplicationCommandType.Message;

    protected constructor(
        context: Command.LoaderContext,
        options: Command.Options,
    ) {
        super(context, options);

        this.contexts = options.contexts ?? [InteractionContextType.Guild];
        this.integrations = options.integrations ?? [
            ApplicationIntegrationType.GuildInstall,
        ];

        this.data = new ContextMenuCommandBuilder()
            .setName(this.rawName)
            .setType(this.type)
            .setContexts(this.contexts)
            .setIntegrationTypes(this.integrations);
    }

    override registerApplicationCommands(registry: Command.Registry) {
        registry.registerContextMenuCommand(this.data);
    }
}

export function MessageMenuCommand(options: Command.Options) {
    return function <
        T extends new (...args: any[]) => AbstractMessageMenuCommand,
    >(Base: T): T {
        return class extends Base {
            constructor(...args: any[]) {
                super(args[0], options);
            }
        } as T;
    };
}
