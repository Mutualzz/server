import { Listener } from "@sapphire/framework";
import type { GuildMember } from "discord.js";
import { Embed } from "../../Builders";

export default class MemberLeaveEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "guildMemberRemove",
            name: "member-leave",
            description: "Logs when a member leaves the server",
        });
    }

    async run(member: GuildMember) {
        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const embed = new Embed()
            .setAuthor({
                name: `${guild?.name} Member Logs`,
                iconURL: guild?.iconURL() ?? "",
            })
            .setTitle(`${member.user.displayName} Left`)
            .setDescription(member.toString())
            .setThumbnail(member.displayAvatarURL())
            .addFields({
                name: "Joined Discord",
                value: `<t:${Math.floor(
                    member.user.createdTimestamp / 1000,
                )}:R>`,
                inline: true,
            })
            .setFooter({ text: `ID: ${member.id}` });

        if (member.joinedTimestamp)
            embed.addFields({
                name: "Joined Server",
                value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`,
                inline: true,
            });

        await logs?.send({ embeds: [embed] });
    }
}
