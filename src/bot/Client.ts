import { type ILogger, LogLevel, SapphireClient } from "@sapphire/framework";
import { Collection, Partials } from "discord.js";
import { Logger } from "@mutualzz/logger";

const logger = new Logger({
    tag: "Asmodeus",
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
});

export class BotClient extends SapphireClient {
    readonly cooldowns = new Collection<string, Collection<string, number>>();

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
        });
    }
}
