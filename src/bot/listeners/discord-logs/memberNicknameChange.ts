import { Listener } from "@sapphire/framework";
import type { GuildMember } from "discord.js";
import { Embed } from "../../Builders";

export default class MemberNicknameChangeEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "guildMemberNicknameUpdate",
            name: "member-nickname-change",
            description: "Logs when member changes nickname",
        });
    }

    async run(
        member: GuildMember,
        oldNickname: string | null,
        newNickname: string | null,
    ) {
        if (oldNickname === newNickname) return;
        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const embed = new Embed()
            .setAuthor({
                name: `${guild?.name} Member Logs`,
                iconURL: guild?.iconURL() ?? "",
            })
            .setTitle(`${member.user.displayName} Changed Nickname`)
            .setThumbnail(member.displayAvatarURL())
            .setDescription(
                `\`Old\`: ${oldNickname ?? "None"}\n\`New\`: ${
                    newNickname ?? "None"
                }`,
            );

        await logs?.send({ embeds: [embed] });
    }
}
