import { Logger } from "@mutualzz/logger";
import Redis from "ioredis";

import { SESSION_EXPIRY } from "./Constants";

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

const storeEvent = async (sessionId: string, s: number, t: string, d: any) => {
    const key = `gateway:events:${sessionId}`;
    await redis.rpush(key, JSON.stringify({ s, t, d }));
    await redis.expire(key, SESSION_EXPIRY);
    await redis.ltrim(key, -100, -1); // Keep only the last 100 events
};

export { redis, storeEvent };
