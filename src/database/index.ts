import mongoose from "mongoose";
import { logger } from "../util/Logger";

export let dbConnection: mongoose.Connection | undefined;

export const startDatabase = async () => {
    if (dbConnection) {
        logger.warning("[Database] already connected");
        return;
    }

    await mongoose
        .connect(process.env.DATABASE ?? "")
        .then(() => {
            logger.info("[Database] connected");
            dbConnection = mongoose.connection;
        })
        .catch((error) => {
            logger.error(`[Database] connection error ${error}`);
        });
};

export const closeDatabase = async () => {
    if (!dbConnection) {
        logger.warning("[Database] not connected");
        return;
    }
    await dbConnection.close();
    logger.info("[Database] disconnected");
};

export * from "./models";
