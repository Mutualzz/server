import type { GatewaySession } from "@mutualzz/types";
import crypto from "crypto";
import { base64UrlEncode, genSnowflake } from "./Common";
import { SESSION_EXPIRY } from "./Constants";
import { redis } from "./Redis";

export const saveSession = async (
    sessionId: string,
    userId: string | null,
    seq: number,
) => {
    await redis.hmset(`gateway:sessions:${sessionId}`, {
        userId,
        seq: seq.toString(),
        updatedAt: Date.now().toString(),
    });

    await redis.expire(`gateway:sessions:${sessionId}`, SESSION_EXPIRY);
};
export const getSession = async (
    sessionId: string,
): Promise<GatewaySession | null> => {
    const data = await redis.hgetall(`gateway:sessions:${sessionId}`);
    if (!data.seq) return null;
    return data as unknown as GatewaySession;
};

if (!process.env.SECRET)
    throw new Error("SECRET environment variable is not set");

export const generateSessionToken = (userId: string) => {
    const timestamp = genSnowflake();
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

export const createSession = async (token: string, userId: string) => {
    const sessionData = JSON.stringify({
        userId,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
    });

    await redis.set(`rest:sessions:${token}`, sessionData);
    await redis.sadd(`users:${userId}:sessions`, token);
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

    const raw = await redis.get(`rest:sessions:${token}`);
    if (!raw) return null;

    const session: GatewaySession = JSON.parse(raw);

    await redis.set(
        `rest:sessions:${token}`,
        JSON.stringify(session),
        "KEEPTTL",
    );

    return session;
};

export const revokeSession = async (token: string) => {
    const raw = await redis.get(`rest:sessions:${token}`);
    if (!raw) return false;

    const { userId } = JSON.parse(raw);

    await redis.del(`rest:sessions:${token}`);
    await redis.srem(`users:${userId}:sessions`, token);

    return true;
};

export const revokeAllSessions = async (userId: string) => {
    const tokens = await redis.smembers(`users:${userId}:sessions`);
    if (tokens.length === 0) return false;

    for (const token of tokens) {
        await redis.del(`rest:sessions:${token}`);
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

    const sessions: GatewaySession[] = [];
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
