import { closeDatabase, startDatabase } from "@mutualzz/database";

import * as Gateway from "@mutualzz/gateway";
import * as REST from "@mutualzz/rest";
import { logger } from "@mutualzz/util";

const rest = new REST.Server();
const gateway = new Gateway.Server();

process.on("SIGTERM", async () => {
    logger.warning("Shutting down due to SIGTERM");
    await gateway.stop();
    await rest.stop();

    await closeDatabase();
});

async function main() {
    await startDatabase();

    await Promise.all([rest.start(), gateway.start()]);
}

main().catch((error) => {
    logger.error(`Error starting server: ${error}`);
});
