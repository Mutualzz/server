import { Listener } from "@sapphire/framework";
import type { Message } from "discord.js";
import { messageLink } from "discord.js";
import isEqual from "lodash/isEqual";
import { Embed } from "../../Builders";

export default class MessageEditedEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageUpdate",
            name: "message-edited",
            description: "Logs when a message is edited",
        });
    }

    async run(oldMessage: Message, newMessage: Message) {
        if (newMessage?.author?.bot) return;
        if (!newMessage.inGuild()) return;
        if (!oldMessage.content && !newMessage.content) return;
        if (
            oldMessage.content === newMessage.content &&
            isEqual(oldMessage.attachments, newMessage.attachments)
        )
            return;
        if (newMessage.author.id === newMessage.client.user.id) return;

        const {
            mainGuild: guild,
            channels: { logs },
        } = this.container.client.metadata;

        const { content: oldContent } = oldMessage;
        const { content: newContent } = newMessage;

        const fromContent =
            oldContent && oldContent.length > 0
                ? `***From***\n\`\`\`${oldContent}\`\`\``
                : "";

        const toContent =
            newContent && newContent.length > 0
                ? `***To***\n\`\`\`${newContent}\`\`\``
                : "";

        const embed = new Embed()
            .setAuthor({
                name: `${guild.name} Message Logs`,
                iconURL: guild.iconURL() ?? undefined,
            })
            .setTitle(`${newMessage.author.displayName} edited a message`)
            .setThumbnail(newMessage.author.displayAvatarURL())
            .setDescription(
                `**Channel**: ${messageLink(newMessage.channelId, newMessage.id)}\n\n${fromContent}\n${toContent}`,
            )
            .setFooter({ text: `ID: ${newMessage.id}` });

        await logs.send({ embeds: [embed] });
    }
}
