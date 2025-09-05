import { closeDatabase, startDatabase } from "@mutualzz/database";

import * as CDN from "@mutualzz/cdn";
import * as Gateway from "@mutualzz/gateway";
import * as REST from "@mutualzz/rest";
import { logger, RabbitMQ } from "@mutualzz/util";

const rest = new REST.Server();
const gateway = new Gateway.Server();
const cdn = new CDN.Server();

process.on("SIGTERM", async () => {
    logger.warning("Shutting down due to SIGTERM");
    await gateway.stop();
    await rest.stop();
    await cdn.stop();

    await RabbitMQ.connection.close();
    await closeDatabase();
});

async function main() {
    await startDatabase();

    await Promise.all([
        RabbitMQ.init(),
        rest.start(),
        gateway.start(),
        cdn.start(),
    ]);
}

main().catch((error) => {
    logger.error(`Error starting server: ${error}`);
});
