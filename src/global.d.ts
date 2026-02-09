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
            mainGuild: Guild | null;
            channels: {
                logs: TextChannel | null;
                birthdays: TextChannel | null;
                officialServersChat: TextChannel | null;
            };
            chats: {
                lobbyMC: ThreadChannel | null;
                smpMC: ThreadChannel | null;
            };
        };

        owner: string;
    }

    export interface GuildMember {
        hasJtc: boolean;
    }

    export interface User {
        birthday?: Date;
        birthdayMessage?: Message;
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

    interface Preconditions {
        OwnerOnly: never;
    }
}
