import initLogger from "@mutualzz/logger";
import path from "path";

export const logger = initLogger(
    path.resolve(import.meta.dirname, "..", "logs"),
    process.env.NODE_ENV,
);
