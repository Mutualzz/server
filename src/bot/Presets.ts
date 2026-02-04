import {
    ActionRowBuilder,
    ContainerBuilder,
    type MessageActionRowComponentBuilder,
    TextDisplayBuilder,
} from "@discordjs/builders";
import { ButtonBuilder, ButtonStyle } from "discord.js";

export const linksPresetComponents = [
    // Desktop Links
    new ContainerBuilder()
        .addTextDisplayComponents((display) =>
            display.setContent("### Desktop Links"),
        )
        .addActionRowComponents((row) =>
            row.addComponents(
                new ButtonBuilder()
                    .setEmoji("💻")
                    .setLabel("App")
                    .setURL("https://mutualzz.com/download")
                    .setStyle(ButtonStyle.Link),
                new ButtonBuilder()
                    .setEmoji("🌐")
                    .setLabel("Website")
                    .setURL("https://mutualzz.com")
                    .setStyle(ButtonStyle.Link),
            ),
        ),
    // Mobile Links
    new ContainerBuilder()
        .addTextDisplayComponents((display) =>
            display.setContent("### Mobile Links"),
        )
        .addActionRowComponents((row) =>
            row.setComponents(
                new ButtonBuilder()
                    .setEmoji({
                        id: "1409239745665564744",
                        name: "apple",
                    })
                    .setLabel("iOS (WIP)")
                    .setURL("https://testflight.apple.com/join/23FhnCyx")
                    .setStyle(ButtonStyle.Link)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setEmoji({
                        id: "1409239964180283402",
                        name: "android",
                    })
                    .setLabel("Android (WIP)")
                    .setURL("https://mutualzz.com")
                    .setStyle(ButtonStyle.Link)
                    .setDisabled(true),
            ),
        ),
    new TextDisplayBuilder().setContent(
        "## <:discord:1464762765158776965> [Invite Link](https://discord.gg/epDUzyWqyg)",
    ),
];

export const birthdaysPresetComponents = [
    new ContainerBuilder()
        .addTextDisplayComponents((display) =>
            display.setContent(
                "**Click one of the buttons or type your birthday in this chat to add it!**",
            ),
        )
        .addActionRowComponents((row) =>
            row.setComponents(
                new ButtonBuilder()
                    .setCustomId("add_birthday")
                    .setEmoji("🎂")
                    .setLabel("Add my birthday")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId("remove_birthday")
                    .setEmoji("😔")
                    .setLabel("Remove my birthday")
                    .setStyle(ButtonStyle.Secondary),
            ),
        ),
];
