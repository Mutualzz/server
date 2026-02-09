import { Listener } from "@sapphire/framework";
import { IDS } from "../../Constants";
import type { Message } from "discord.js";
import { publishIntegration } from "@mutualzz/util";
import { randomUUID } from "crypto";

type ServerId = "lobby" | "smp";

const getServerIdFromDiscordChannel = (channelId: string): ServerId | null => {
    if (channelId === IDS.CHATS.LOBBY_MC) return "lobby";
    if (channelId === IDS.CHATS.SMP_MC) return "smp";
    return null;
};

const normalizeText = (s: string) => s.replace(/\r?\n/g, " ").trim();

export default class ChatBridgeListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageCreate",
            name: "minecraft-chat-bridge",
            description:
                "Bridges chat messages from Discord to Minecraft servers.",
        });
    }

    async run(message: Message) {
        if (message.webhookId) return;
        if (!message.inGuild()) return;
        if (message.author.bot) return;

        const text = normalizeText(message.content);
        if (text.length === 0) return;

        const serverId = getServerIdFromDiscordChannel(message.channelId);
        if (!serverId) return;

        const type = "discord.chat.message.create.v1";
        const routingKey = `${type}.${serverId}`;

        const { member } = message;

        await publishIntegration(routingKey, {
            v: 1,
            type,
            ts: Date.now(),
            id: randomUUID(),
            source: "discord-bot",
            data: {
                serverId,
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: message.id,
                member: {
                    id: message.id,
                    username: message.author.username,
                    roleColor: member?.displayHexColor || "#ffffff",
                    displayName: member?.displayName || member?.user.username,
                },
                content: { text },
            },
        });
    }
}
