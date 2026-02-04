import { Listener } from "@sapphire/framework";
import { type Client, ChannelType, Collection } from "discord.js";
import { CronJob } from "cron";
import ms from "ms";
import { IDs } from "../../IDs";
import { sendBirthdaysMessage } from "bot/util";

export default class ReadyEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            once: true,
            event: "clientReady",
            name: "client-ready",
            description: "Emitted when the client is ready.",
        });
    }

    async run(client: Client<true>) {
        const { logger } = this.container;

        client.user.setPresence(client.getActivity());

        new CronJob("*/1 * * * *", () => {
            client.user.setPresence(client.getActivity());
        }).start();

        const mainGuild = client.guilds.cache.get(IDs.MAIN_GUILD);
        if (mainGuild) client.metadata.mainGuild = mainGuild;

        const logsChannel = client.channels.cache.get(IDs.CHANNELS.LOGS);
        if (logsChannel?.type === ChannelType.GuildText)
            client.metadata.channels.logs = logsChannel;

        const birthdaysChannel = client.channels.cache.get(
            IDs.CHANNELS.BIRTHDAYS,
        );
        if (birthdaysChannel?.type === ChannelType.GuildText)
            client.metadata.channels.birthdays = birthdaysChannel;

        // Setup join to create categories
        const joinToCreateCouchCategory = client.channels.cache.get(
            IDs.JOIN_TO_CREATE.COUCH_CATEGORY,
        );
        if (joinToCreateCouchCategory?.type === ChannelType.GuildCategory)
            client.joinToCreate.set(
                joinToCreateCouchCategory.id,
                new Collection(),
            );

        await sendBirthdaysMessage(client);

        logger.info(`[Client] Started in ${ms(Date.now() - client.startTime)}`);
        logger.info(`[Client] Ready as ${client.user.tag}`);
    }
}
