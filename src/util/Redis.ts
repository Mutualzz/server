import { Logger } from "@mutualzz/logger";
import Redis from "ioredis";

const logger = new Logger({
    tag: "Redis",
});

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USERNAME,
});

redis.on("ready", () => {
    logger.info("Connected to Redis");
});

redis.on("error", (err) => {
    logger.error("Redis error:", err);
});

export { redis };
