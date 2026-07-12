import { Listener } from "@sapphire/framework";
import type { Message } from "discord.js";
import { DiscordBridgePeer } from "../../bridge/DiscordBridgePeer";

export default class BridgeMessageListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "messageCreate",
            name: "bridge-message-create",
            description:
                "Forwards Discord messages in bound channels to the Minecraft bridge hub",
        });
    }

    async run(message: Message) {
        await DiscordBridgePeer.onDiscordMessage(message);
    }
}
