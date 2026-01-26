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
import { BotClient } from "../bot/Client.ts";

const logger = new Logger({
    tag: "Bundle",
});

const rest = new REST.Server();
const gateway = new Gateway.Server();
const cdn = new CDN.Server();
const botClient = new BotClient();

process.on("SIGTERM", async () => {
    logger.warn("Shutting down due to SIGTERM");
    await gateway.stop();
    await rest.stop();
    await cdn.stop();
    await botClient.destroy();

    await RabbitMQ.connection.close();
    await closeDatabase();
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
    logger.error(`Error starting server: ${error}`);
});
