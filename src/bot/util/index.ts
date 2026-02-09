import {
    ApplicationCommandOptionType,
    ChannelType,
    type User,
    type Client,
    type SlashCommandSubcommandBuilder,
    ThreadAutoArchiveDuration,
} from "discord.js";
import type { SlashCommandBuilder } from "@discordjs/builders";
import type { SlashCommandOption } from "../types";
import { birthdaysPresetComponents, linksPresetComponents } from "../Presets";
import { IDS } from "../Constants";
import { db, discordUsersTable } from "@mutualzz/database";
import { eq } from "drizzle-orm";

export const addOption = (
    builder: SlashCommandBuilder | SlashCommandSubcommandBuilder,
    option: SlashCommandOption,
) => {
    switch (option.type) {
        case ApplicationCommandOptionType.Boolean:
            builder.addBooleanOption(option);
            break;
        case ApplicationCommandOptionType.Attachment:
            builder.addAttachmentOption(option);
            break;
        case ApplicationCommandOptionType.String:
            builder.addStringOption(option);
            break;
        case ApplicationCommandOptionType.Integer:
            builder.addIntegerOption(option);
            break;
        case ApplicationCommandOptionType.User:
            builder.addUserOption(option);
            break;
        case ApplicationCommandOptionType.Channel:
            builder.addChannelOption(option);
            break;
        case ApplicationCommandOptionType.Role:
            builder.addRoleOption(option);
            break;
        case ApplicationCommandOptionType.Mentionable:
            builder.addMentionableOption(option);
            break;
        case ApplicationCommandOptionType.Number:
            builder.addNumberOption(option);
            break;
    }
};

export const sendOfficialLinksMessage = async (client: Client) => {
    const channel = client.channels.cache.get("1409043388052803634");
    if (channel?.type !== ChannelType.GuildText) return;

    const webhook = await channel.createWebhook({
        name: "Official Links",
        avatar: client.user?.displayAvatarURL(),
    });

    await webhook.send({
        components: linksPresetComponents,
        flags: "IsComponentsV2",
    });

    await webhook.delete();
};

export const sendBirthdaysMessage = async (client: Client) => {
    const channel = client.metadata.channels.birthdays;
    if (channel?.type !== ChannelType.GuildText) return;

    const webhook = await channel.createWebhook({
        name: "Birthdays",
        avatar: client.user?.displayAvatarURL(),
    });

    await webhook.send({
        components: birthdaysPresetComponents,
        flags: "IsComponentsV2",
    });

    await webhook.delete();
};

export const createMinecraftServersChatThreads = async (client: Client) => {
    const channel = client.channels.cache.get(
        IDS.CHANNELS.OFFICIAL_SERVERS_CHAT,
    );
    if (channel?.type !== ChannelType.GuildText) return;

    await Promise.all(
        ["Lobby Chat", "SMP Chat"].map(async (threadName) => {
            const message = await channel.send({
                content: `**This is the ${threadName} minecraft chat bridge**`,
            });

            return message.startThread({
                name: threadName,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
            });
        }),
    );
};

export const isCouchCategory = (channelId: string) => {
    return channelId === IDS.JOIN_TO_CREATE.COUCH_CATEGORY;
};

export const getUserBirthday = async (user: User) => {
    if (!user.birthday) {
        const dbUser = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(user.id)),
        });

        if (!dbUser) return user.birthday;

        if (dbUser.birthday) {
            user.birthday = new Date(dbUser.birthday);
            return user.birthday;
        }

        return user.birthday;
    }

    return user.birthday;
};
