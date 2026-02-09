import { Listener } from "@sapphire/framework";
import type { Message } from "discord.js";
import { AuditLogEvent } from "discord.js";
import { Embed } from "../../Builders";

export default class MessageDeletedEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageDelete",
            name: "message-deleted",
            description: "Logs when a message is deleted",
        });
    }

    async run(message: Message) {
        // NOTE: author can be null, if its a webhook message
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!message.author) return;
        if (message.author.bot) return;
        if (!message.inGuild()) return;

        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const audit = await guild
            ?.fetchAuditLogs({
                type: AuditLogEvent.MessageDelete,
            })
            .then((audit) => audit.entries.first());

        let title = "Message was deleted";

        if (audit) {
            const { executor: deletedBy } = audit;
            if (deletedBy) title += ` by ${deletedBy.displayName}`;
        }

        title += ` that was sent by ${message.author.displayName}`;

        const attachments = message.attachments.toJSON();

        const embed = new Embed()
            .setAuthor({
                name: `${guild?.name} Message Logs`,
                iconURL: guild?.iconURL() || undefined,
            })
            .setTitle(title)
            .setDescription(
                message.content.length > 0
                    ? `\n\`\`\`${message.content}\`\`\``
                    : null,
            )
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: `ID: ${message.id}` });

        await logs?.send({ embeds: [embed], files: attachments });
    }
}
