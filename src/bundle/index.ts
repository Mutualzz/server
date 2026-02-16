import * as CDN from "@mutualzz/cdn";
import {
    closeDatabase,
    initDatabaseShutdownHooks,
    startDatabase,
} from "@mutualzz/database";
import * as Gateway from "@mutualzz/gateway";
import { Logger } from "@mutualzz/logger";
import * as REST from "@mutualzz/rest";
import { RabbitMQ } from "@mutualzz/util";
import { BotClient } from "../bot/Client";

const logger = new Logger({
    tag: "Bundle",
});

const rest = new REST.Server();
const gateway = new Gateway.Server();
const cdn = new CDN.Server();
const botClient = new BotClient();

process.on("SIGTERM", async () => {
    logger.warn("Shutting down due to SIGTERM");

    await Promise.all([
        gateway.stop(),
        rest.stop(),
        cdn.stop(),
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
        botClient.login(),
    ]);
}

main().catch((error) => {
    logger.error("Error starting server", error);
});
