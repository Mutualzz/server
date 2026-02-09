import "@sapphire/plugin-subcommands/register";

import { type ILogger, LogLevel, SapphireClient } from "@sapphire/framework";
import {
    Collection,
    Partials,
    type PresenceData,
    ActivityType,
    type Guild,
    type TextChannel,
    type VoiceChannel,
    type ThreadChannel,
} from "discord.js";
import { Logger } from "@mutualzz/logger";
import { pickRandom } from "@sapphire/utilities";
import dLogs from "discord-logs";
import path from "path";

const { BOT_TOKEN } = process.env;

const logger = new Logger({
    tag: "Asmodeus",
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
});

if (!BOT_TOKEN)
    throw new Error("BOT_TOKEN is not defined in environment variables");

// NOTE: If I am using "!" to assert non-null, it will be because I am certain it's non-null. Since the bot is designed to run in only one guild.
export class BotClient extends SapphireClient {
    readonly startTime = Date.now();

    readonly cooldowns = new Collection<string, Collection<string, number>>();

    // Deep nested collections for Join-To-Create voice channels. String -> CategoryChannel -> VoiceChannel
    // The first string key is the category ID, mapping to another collection where the key is the voice channel ID
    readonly joinToCreate = new Collection<
        string,
        Collection<string, VoiceChannel>
    >();

    // The main guild where the bot operates (primary server)
    // readonly because metadata should not be reassigned directly, only its properties modified
    readonly metadata: {
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

    readonly owner: string = "401269337924829186"; // Azrael's ID

    constructor() {
        super({
            intents: [
                "AutoModerationConfiguration",
                "AutoModerationExecution",
                "DirectMessagePolls",
                "DirectMessages",
                "DirectMessageReactions",
                "DirectMessageTyping",
                "Guilds",
                "GuildEmojisAndStickers",
                "GuildBans",
                "GuildExpressions",
                "GuildIntegrations",
                "GuildInvites",
                "GuildMembers",
                "GuildMessagePolls",
                "GuildMessageReactions",
                "GuildMessages",
                "GuildMessageTyping",
                "GuildModeration",
                "GuildPresences",
                "GuildScheduledEvents",
                "GuildVoiceStates",
                "GuildWebhooks",
                "MessageContent",
            ],
            partials: [
                Partials.User,
                Partials.Channel,
                Partials.GuildMember,
                Partials.Message,
                Partials.Reaction,
                Partials.GuildScheduledEvent,
                Partials.ThreadMember,
                Partials.SoundboardSound,
                Partials.Poll,
                Partials.PollAnswer,
            ],
            shards: "auto",
            logger: {
                level:
                    process.env.NODE_ENV === "development"
                        ? LogLevel.Debug
                        : LogLevel.Info,
                instance: logger as unknown as ILogger,
            },
            loadMessageCommandListeners: true,
            loadApplicationCommandRegistriesStatusListeners: true,
            loadDefaultErrorListeners: true,
            loadSubcommandErrorListeners: true,
            baseUserDirectory: path.resolve(import.meta.dirname),
        });

        // Initialize metadata with placeholders to be set later on ready
        this.metadata = {
            mainGuild: null,
            channels: {
                logs: null,
                birthdays: null,
                officialServersChat: null,
            },
            chats: {
                lobbyMC: null,
                smpMC: null,
            },
        };
    }

    getActivities(): PresenceData[] {
        return [
            {
                status: "online",
                activities: [
                    {
                        name: "Visit our app at mutualzz.com",
                        type: ActivityType.Streaming,
                        url: "https://mutualzz.com",
                    },
                ],
            },
        ];
    }

    getActivity = () => pickRandom(this.getActivities());

    async login() {
        // ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(
        //     RegisterBehavior.BulkOverwrite,
        // );

        await dLogs(this, {
            debug: process.env.NODE_ENV === "development",
        });

        return super.login(process.env.BOT_TOKEN);
    }

    mentionCommand(
        command: string,
        extra: {
            subcommand: string;
            group: string;
        },
    ): string {
        if (!this.isReady()) return "";
        const appCommand = this.application.commands.cache.find(
            (c) => c.name === command,
        );
        if (!appCommand) {
            this.logger.error(
                `Couldn't mention ${command}, since it doesn't exist`,
            );
            return "";
        }

        let commandLiteral = command;
        if (extra.group) commandLiteral += ` ${extra.group}`;
        if (extra.subcommand) commandLiteral += ` ${extra.subcommand}`;

        return `</${commandLiteral}:${appCommand.id}>`;
    }
}
