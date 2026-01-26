import { Listener } from "@sapphire/framework";
import { ChannelType, type GuildMember, type VoiceChannel } from "discord.js";
import { isCouchCategory } from "../../util";
import { IDs } from "../../IDs";

export default class VoiceChannelJoinEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "voiceChannelJoin",
            name: "voice-channel-join",
            description: "Handles join to create voice channels",
        });
    }

    async run(member: GuildMember, voiceChannel: VoiceChannel) {
        if (
            !IDs.JOIN_TO_CREATE.CREATION_VOICE_CHANNELS.includes(
                voiceChannel.id,
            )
        )
            return;
        if (member.hasJtc) return;
        const { parent: parentCategory } = voiceChannel;
        if (!parentCategory) return;

        // Join-To-Create Category Check
        const jtcCategory = this.container.client.joinToCreate.get(
            parentCategory.id,
        );
        if (!jtcCategory) return;

        let channelName = `${member.displayName}'s Channel`;
        if (isCouchCategory(parentCategory.id))
            channelName = `${member.displayName}'s Couch`;

        const newVoiceChannel = await parentCategory.children.create({
            type: ChannelType.GuildVoice,
            name: channelName,
            permissionOverwrites: [
                {
                    id: member.id,
                    allow: [
                        "Connect",
                        "Speak",
                        "ViewChannel",
                        "ManageChannels",
                        "ManageRoles",
                    ],
                },
            ],
        });

        newVoiceChannel.ownerId = member.id;

        jtcCategory.set(newVoiceChannel.id, newVoiceChannel);
        await member.voice.setChannel(newVoiceChannel);

        member.hasJtc = true;

        newVoiceChannel.send(
            `Welcome ${member}! This is your personal voice channel. Enjoy your stay!`,
        );
    }
}
