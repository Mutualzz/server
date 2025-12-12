import type { GatewaySession } from "@mutualzz/types";
import { LRUCache } from "lru-cache";
import { SESSION_EXPIRY } from "../../util/Constants";
import { redis } from "../../util/Redis";

if (!process.env.SECRET)
    throw new Error("SECRET environment variable is not set");

export const sessionLRU = new LRUCache<string, GatewaySession>({
    max: 1000,
    ttl: SESSION_EXPIRY * 1000,
});

interface SaveSessionOpts {
    sessionId: string;
    userId: string | bigint | null;
    seq: number;
}

export const saveSession = async ({
    sessionId,
    userId,
    seq,
}: SaveSessionOpts) => {
    if (!userId) return;
    userId = userId.toString();

    const session: GatewaySession = {
        userId,
        seq,
        lastUsedAt: Date.now(),
    };

    await redis.hmset(`gateway:sessions:${sessionId}`, {
        userId,
        seq: seq.toString(),
        lastUsedAt: session.lastUsedAt.toString(),
    });

    await redis.expire(`gateway:sessions:${sessionId}`, SESSION_EXPIRY);

    sessionLRU.set(sessionId, session);
};

export const getSession = async (
    sessionId: string,
): Promise<GatewaySession | null> => {
    let session = sessionLRU.get(sessionId);
    if (session) return session;

    const data = await redis.hgetall(`gateway:sessions:${sessionId}`);
    if (!data.seq) return null;

    session = {
        userId: data.userId,
        seq: Number(data.seq),
        lastUsedAt: Number(data.lastUsedAt),
    };

    sessionLRU.set(sessionId, session);

    return session;
};

export const revokeSession = async (sessionId: string) => {
    const session = await getSession(sessionId);
    if (!session) return false;

    const userId = session.userId.toString();

    await redis.del(`gateway:sessions:${sessionId}`);

    await redis.srem(`users:${userId}:gatewaySessions`, sessionId);

    sessionLRU.delete(sessionId);

    return true;
};
