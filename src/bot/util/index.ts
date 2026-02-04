import {
    ApplicationCommandOptionType,
    ChannelType,
    type Client,
    type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { SlashCommandBuilder } from "@discordjs/builders";
import type { SlashCommandOption } from "../types";
import { birthdaysPresetComponents, linksPresetComponents } from "../Presets";
import { IDS } from "../Constants";

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
    if (!channel || channel.type !== ChannelType.GuildText) return;

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

export const isCouchCategory = (channelId: string) => {
    return channelId === IDS.JOIN_TO_CREATE.COUCH_CATEGORY;
};
