import * as CDN from "@mutualzz/cdn";
import {
    closeDatabase,
    initDatabaseShutdownHooks,
    startDatabase,
} from "@mutualzz/database";
import * as Gateway from "@mutualzz/gateway";
import { Logger } from "@mutualzz/logger";
import { MinecraftBridgeServer, AppBridgePeer } from "@mutualzz/minecraft";
import * as REST from "@mutualzz/rest";

import { RabbitMQ } from "@mutualzz/util";
import { startGameCatalogSyncSchedule } from "../util/GameCatalogSync.ts";
import { BotClient } from "../bot/Client";

const logger = new Logger({
    tag: "Bundle",
});

const rest = new REST.Server();
const gateway = new Gateway.Server();
const cdn = new CDN.Server();
const minecraftBridge = new MinecraftBridgeServer();
const botClient = new BotClient();

process.on("SIGTERM", async () => {
    logger.warn("Shutting down due to SIGTERM");

    AppBridgePeer.stop();
    await Promise.all([
        gateway.stop(),
        rest.stop(),
        cdn.stop(),
        minecraftBridge.stop(),
        botClient.destroy(),
        RabbitMQ.connection.close(),
        closeDatabase(),
    ]);
});

async function main() {
    await startDatabase();
    initDatabaseShutdownHooks();

    await Promise.all([
        RabbitMQ.init(),
        rest.start(),
        gateway.start(),
        cdn.start(),
        minecraftBridge.start(),
        botClient.login(),
    ]);

    await AppBridgePeer.start();
    startGameCatalogSyncSchedule();
}

main().catch((error) => {
    logger.error("Error starting server", error);
});
