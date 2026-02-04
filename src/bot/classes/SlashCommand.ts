import { SlashCommandBuilder } from "@discordjs/builders";
import { Command } from "@sapphire/framework";
import type { SlashCommandOption } from "../types";
import { addOption } from "../util";
import { ApplicationIntegrationType, InteractionContextType } from "discord.js";

export abstract class AbstractSlashCommand extends Command {
    readonly data: SlashCommandBuilder;

    readonly contexts: InteractionContextType[];
    readonly integrations: ApplicationIntegrationType[];

    readonly opts?: SlashCommandOption[];

    public constructor(
        content: Command.LoaderContext,
        options: Command.Options,
    ) {
        super(content, options);

        this.contexts = options.contexts ?? [InteractionContextType.Guild];
        this.integrations = options.integrations ?? [
            ApplicationIntegrationType.GuildInstall,
        ];

        this.data = new SlashCommandBuilder()
            .setName(this.name)
            .setDescription(this.description)
            .setContexts(this.contexts)
            .setIntegrationTypes(this.integrations);

        if (options.opts) {
            for (const opt of options.opts) {
                addOption(this.data, opt);
            }
        }
    }

    override registerApplicationCommands(registry: Command.Registry) {
        registry.registerChatInputCommand(this.data);
    }
}

export function SlashCommand(options: Command.Options) {
    return function <T extends new (...args: any[]) => AbstractSlashCommand>(
        Base: T,
    ): T {
        return class extends Base {
            constructor(...args: any[]) {
                super(args[0], options);
            }
        } as T;
    };
}
