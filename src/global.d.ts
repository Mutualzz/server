import type { SlashCommandOption } from "@typings";
import type {
    ApplicationIntegrationType,
    Collection,
    InteractionContextType,
    Guild,
    TextChannel,
} from "discord.js";

declare module "discord.js" {
    export interface Client {
        readonly startTime: number;
        readonly cooldowns: Collection<string, Collection<string, number>>;

        readonly joinToCreate: Collection<
            string,
            Collection<string, VoiceChannel>
        >;

        getActivities(): PresenceData[];
        getActivity(): PresenceData;

        metadata: {
            mainGuild: Guild;
            channels: {
                logs: TextChannel;
                birthdays: TextChannel;
            };
        };
    }

    export interface GuildMember {
        hasJtc: boolean;
    }

    export interface VoiceChannel {
        ownerId?: string;
    }
}

declare module "@sapphire/plugin-subcommands" {
    export interface SubcommandMappingMethod {
        description: string;
        opts?: SlashCommandOption[];
    }

    export interface SubcommandMappingGroup {
        description: string;
    }
}

declare module "@sapphire/framework" {
    export interface CommandOptions {
        contexts?: InteractionContextType[];
        integrations?: ApplicationIntegrationType[];
        opts?: SlashCommandOption[];
    }

    export interface ListenerOptions {
        description: string;
    }
}
