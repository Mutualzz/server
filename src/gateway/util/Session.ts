import type { GatewaySession } from "@mutualzz/types";
import { SESSION_EXPIRY } from "../../util/Constants";
import { redis } from "../../util/Redis";

if (!process.env.SECRET)
    throw new Error("SECRET environment variable is not set");

interface SaveSessionOpts {
    sessionId: string;
    userId: string | null;
    seq: number;
}

export const saveSession = async ({
    sessionId,
    userId,
    seq,
}: SaveSessionOpts) => {
    await redis.hmset(`gateway:sessions:${sessionId}`, {
        userId,
        seq: seq.toString(),
        lastUsedAt: Date.now().toString(),
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
