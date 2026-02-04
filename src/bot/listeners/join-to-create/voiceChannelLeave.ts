import { Listener } from "@sapphire/framework";
import type { GuildMember, VoiceChannel } from "discord.js";
import { IDS } from "../../Constants";

export default class VoiceChannelLeaveEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "voiceChannelLeave",
            name: "voice-channel-leave",
            description: "Handles join to create voice channels",
        });
    }

    // TODO: Fix it so when user switches channels, it does the same thing as leaving or joining which needs voiceChannelSwitch
    async run(member: GuildMember, voiceChannel: VoiceChannel) {
        if (
            IDS.JOIN_TO_CREATE.CREATION_VOICE_CHANNELS.includes(voiceChannel.id)
        )
            return;
        if (!member.hasJtc) return;
        const { parent: parentCategory } = voiceChannel;
        if (!parentCategory) return;

        // Join-To-Create Category Check
        const jtcCategory = this.container.client.joinToCreate.get(
            parentCategory.id,
        );
        if (!jtcCategory) return;

        if (voiceChannel.members.size > 0) {
            const randomMember = voiceChannel.members.random();
            if (randomMember) {
                voiceChannel.ownerId = randomMember.id;
                await voiceChannel.send(
                    `The new owner of this channel is now ${randomMember}!`,
                );
                randomMember.hasJtc = true;
            }

            member.hasJtc = false;
            return;
        }

        // Remove the channel from the collection
        jtcCategory.delete(voiceChannel.id);

        // Delete the voice channel
        await voiceChannel.delete();

        member.hasJtc = false;
    }
}
