import type { RESTSession } from "@mutualzz/types";
import { base64UrlDecode, base64UrlEncode, redis, Snowflake } from "@mutualzz/util";
import crypto from "crypto";
import { LRUCache } from "lru-cache";

export const sessionLRU = new LRUCache<string, RESTSession>({
    max: 1000,
    ttl: 5 * 60 * 1000, // 5 minutes
});

// Sliding session lifetime: refreshed on every touch (see verifySessionToken),
// so a session only expires after this long of inactivity.
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const generateSessionToken = (userId: string) => {
    userId = userId.toString();

    const timestamp = Snowflake.generate();
    const base64UrlId = base64UrlEncode(userId);
    const base64Timestamp = base64UrlEncode(timestamp);

    const data = `${base64UrlId}.${base64Timestamp}`;
    const signature = base64UrlEncode(
        crypto
            .createHmac("sha256", process.env.SECRET as string)
            .update(data)
            .digest(),
    );

    return `${data}.${signature}`;
};

export const createSession = async (
    token: string,
    userId: string | bigint,
    sessionId: string,
) => {
    userId = userId.toString();

    const sessionData = {
        sessionId,
        userId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
    };

    await redis.set(
        `rest:sessions:${token}`,
        JSON.stringify(sessionData),
        "EX",
        SESSION_TTL_SECONDS,
    );
    await redis.sadd(`users:${userId}:sessions`, token);

    sessionLRU.set(token, sessionData);

    return sessionData;
};

export const verifySessionToken = async (token: string) => {
    const [base64UserId, base64Timestamp, signature] = token.split(".");

    if (!base64UserId || !base64Timestamp || !signature) return null;

    const data = `${base64UserId}.${base64Timestamp}`;
    const expectedSignature = base64UrlEncode(
        crypto
            .createHmac("sha256", process.env.SECRET as string)
            .update(data)
            .digest(),
    );
    if (expectedSignature !== signature) return null;

    let session = sessionLRU.get(token);

    if (!session) {
        const raw = await redis.get(`rest:sessions:${token}`);
        if (!raw) {
            // Session expired (or was never created) — drop the dangling
            // reference from the user's session set, if any.
            const userId = base64UrlDecode(base64UserId);
            await redis.srem(`users:${userId}:sessions`, token);
            return null;
        }

        session = JSON.parse(raw);
        if (!session) return null;

        sessionLRU.set(token, session);
    }

    if (!session) return null;

    const now = Date.now();
    if (!session.lastUsedAt || now - session.lastUsedAt > 300000) {
        session.lastUsedAt = now;
        // Reset the TTL on each touch so active sessions stay alive
        // indefinitely, while abandoned ones age out after SESSION_TTL_SECONDS.
        await redis.set(
            `rest:sessions:${token}`,
            JSON.stringify(session),
            "EX",
            SESSION_TTL_SECONDS,
        );
    }

    return session;
};

export const revokeSession = async (token: string) => {
    const raw = await redis.get(`rest:sessions:${token}`);
    if (!raw) return false;

    const { userId } = JSON.parse(raw);

    await redis.del(`rest:sessions:${token}`);
    await redis.srem(`users:${userId}:sessions`, token);

    sessionLRU.delete(token);

    return true;
};

export const revokeAllSessions = async (userId: string) => {
    const tokens = await redis.smembers(`users:${userId}:sessions`);
    if (tokens.length === 0) return false;

    for (const token of tokens) {
        await redis.del(`rest:sessions:${token}`);
        sessionLRU.delete(token);
    }

    await redis.del(`users:${userId}:sessions`);

    return true;
};

export const listSessions = async (userId: string) => {
    const tokens = await redis.smembers(`users:${userId}:sessions`);
    if (tokens.length === 0) return [];

    const keys = tokens.map((token) => `rest:sessions:${token}`);

    const pipeline = redis.multi();
    for (const key of keys) {
        pipeline.get(key);
    }

    const rawResults = await pipeline.exec();
    if (!rawResults || !Array.isArray(rawResults)) return [];

    const sessions: RESTSession[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const result = rawResults[i];
        const [err, raw] = result;
        if (err || !raw) continue;

        sessions.push({
            ...JSON.parse(raw as string),
            token: tokens[i],
        });
    }

    return sessions;
};
