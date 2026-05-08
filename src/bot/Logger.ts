import { Logger } from "@mutualzz/logger";

export const logger = new Logger({
    tag: "Bot",
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
});
