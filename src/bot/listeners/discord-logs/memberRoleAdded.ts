import { Listener } from "@sapphire/framework";
import type { GuildMember, Role } from "discord.js";
import { AuditLogEvent } from "discord.js";
import { Embed } from "../../Builders";

export default class MemberRoleAddEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "guildMemberRoleAdd",
            name: "member-role-add",
            description: "Logs when member has a role added",
        });
    }

    async run(member: GuildMember, role: Role) {
        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const audit = await guild
            ?.fetchAuditLogs({
                type: AuditLogEvent.MemberRoleUpdate,
            })
            .then((audit) => audit.entries.first());

        let title = `${member.user.displayName} had a role added`;

        if (audit && audit.changes[0].key === "$add") {
            const { executor: addedBy } = audit;
            if (addedBy) title = `${title} by ${addedBy.displayName}`;
        }

        const embed = new Embed()
            .setAuthor({
                name: `${guild?.name} Member Logs`,
                iconURL: guild?.iconURL() ?? "",
            })
            .setTitle(title)
            .setThumbnail(member.displayAvatarURL())
            .setDescription(`${role} was added`);

        await logs?.send({ embeds: [embed] });
    }
}
