import {
    SlashCommandBuilder,
    SlashCommandSubcommandBuilder,
    SlashCommandSubcommandGroupBuilder,
} from "@discordjs/builders";
import {
    Subcommand,
    type SubcommandMappingArray,
    type SubcommandMappingMethod,
} from "@sapphire/plugin-subcommands";
import type { SlashCommandOption } from "../types";
import { addOption } from "../util";
import { ApplicationIntegrationType, InteractionContextType } from "discord.js";

export abstract class AbstractSlashSubcommand extends Subcommand {
    readonly data: SlashCommandBuilder;

    readonly contexts: InteractionContextType[];
    readonly integrations: ApplicationIntegrationType[];

    readonly opts?: SlashCommandOption[];
    readonly subcommands?: SubcommandMappingArray;

    protected constructor(
        content: Subcommand.LoaderContext,
        options: Subcommand.Options,
    ) {
        super(content, options);

        this.contexts = options.contexts ?? [InteractionContextType.Guild];
        this.integrations = options.integrations ?? [
            ApplicationIntegrationType.GuildInstall,
        ];

        this.data = new SlashCommandBuilder()
            .setName(this.rawName)
            .setDescription(this.description)
            .setContexts(this.contexts)
            .setIntegrationTypes(this.integrations);

        if (options.subcommands && options.opts)
            throw new Error(
                "You cannot use subcommands and options at the same time.",
            );

        if (options.opts) {
            for (const opt of options.opts) {
                addOption(this.data, opt);
            }
        }

        if (options.subcommands) {
            const subcommands = options.subcommands.filter(
                (cmd) => cmd.type === "method",
            ) as SubcommandMappingMethod[];
            const groups = options.subcommands.filter(
                (cmd) => cmd.type === "group",
            );

            for (const subcommand of subcommands) {
                const subcommandBuilder = new SlashCommandSubcommandBuilder()
                    .setName(subcommand.name)
                    .setDescription(subcommand.description);

                if (subcommand.opts) {
                    for (const opt of subcommand.opts) {
                        addOption(subcommandBuilder, opt);
                    }
                }

                this.data.addSubcommand(subcommandBuilder);
            }

            for (const group of groups) {
                const groupBuilder = new SlashCommandSubcommandGroupBuilder()
                    .setName(group.name)
                    .setDescription(group.description);

                for (const subcommand of group.entries) {
                    const subcommandBuilder =
                        new SlashCommandSubcommandBuilder()
                            .setName(subcommand.name)
                            .setDescription(subcommand.description);

                    if (subcommand.opts) {
                        for (const opt of subcommand.opts) {
                            addOption(subcommandBuilder, opt);
                        }
                    }

                    groupBuilder.addSubcommand(subcommandBuilder);
                }

                this.data.addSubcommandGroup(groupBuilder);
            }
        }
    }

    override registerApplicationCommands(registry: Subcommand.Registry) {
        registry.registerChatInputCommand(this.data);
    }
}

export function SlashSubcommand(options: Subcommand.Options) {
    return function <T extends new (...args: any[]) => AbstractSlashSubcommand>(
        Base: T,
    ): T {
        return class extends Base {
            constructor(...args: any[]) {
                super(args[0], options);
            }
        } as T;
    };
}
