import { Listener } from "@sapphire/framework";
import type { GuildMember, Role } from "discord.js";
import { AuditLogEvent } from "discord.js";
import { Embed } from "../../Builders";

export default class MemberRoleRemovedEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "guildMemberRoleRemove",
            name: "member-role-remove",
            description: "Logs when member has a role removed",
        });
    }

    async run(member: GuildMember, role: Role) {
        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const audit = await guild
            .fetchAuditLogs({
                type: AuditLogEvent.MemberRoleUpdate,
            })
            .then((audit) => audit.entries.first());

        let title = `${member.user.displayName} had a role removed`;

        if (audit && audit.changes[0].key === "$remove") {
            const { executor: removedBy } = audit;
            if (removedBy) title = `${title} by ${removedBy.displayName}`;
        }

        const embed = new Embed()
            .setAuthor({
                name: `${guild.name} Member Logs`,
                iconURL: guild.iconURL() ?? "",
            })
            .setTitle(title)
            .setThumbnail(member.displayAvatarURL())
            .setDescription(`${role} was removed`);

        await logs.send({ embeds: [embed] });
    }
}
