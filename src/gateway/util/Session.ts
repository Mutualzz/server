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

const pendingSeqPersists = new Map<
    string,
    { seq: number; timer: NodeJS.Timeout }
>();

async function writeSessionSeq(sessionId: string, seq: number) {
    const lastUsedAt = Date.now();
    const cached = sessionLRU.get(sessionId);
    const nextSeq = cached ? Math.max(cached.seq, seq) : seq;

    if (cached) {
        cached.seq = nextSeq;
        cached.lastUsedAt = lastUsedAt;
        sessionLRU.set(sessionId, cached);
    }

    await redis.hmset(`gateway:sessions:${sessionId}`, {
        seq: String(nextSeq),
        lastUsedAt: String(lastUsedAt),
    });
    await redis.expire(`gateway:sessions:${sessionId}`, SESSION_EXPIRY);
}

export const saveSession = async ({
    sessionId,
    userId,
    seq,
}: SaveSessionOpts) => {
    if (!userId) return;
    userId = userId.toString();

    const pending = pendingSeqPersists.get(sessionId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingSeqPersists.delete(sessionId);
        seq = Math.max(seq, pending.seq);
    }

    const cached = sessionLRU.get(sessionId);
    if (cached) {
        seq = Math.max(seq, cached.seq);
    }

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
    await redis.sadd(`users:${userId}:gatewaySessions`, sessionId);

    sessionLRU.set(sessionId, session);
};

export const touchSessionSeq = (sessionId: string, seq: number) => {
    const session = sessionLRU.get(sessionId);
    if (session) {
        session.seq = Math.max(session.seq, seq);
        session.lastUsedAt = Date.now();
        sessionLRU.set(sessionId, session);
    }

    const existing = pendingSeqPersists.get(sessionId);
    if (existing) {
        existing.seq = Math.max(existing.seq, seq);
        return;
    }

    const entry = {
        seq,
        timer: setTimeout(() => {
            pendingSeqPersists.delete(sessionId);
            void writeSessionSeq(sessionId, entry.seq).catch(() => null);
        }, 1000),
    };
    entry.timer.unref?.();
    pendingSeqPersists.set(sessionId, entry);
};

export const flushSessionSeq = async (sessionId: string, seq?: number) => {
    const pending = pendingSeqPersists.get(sessionId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingSeqPersists.delete(sessionId);
        seq = Math.max(seq ?? 0, pending.seq);
    }
    if (seq == null) return;
    await writeSessionSeq(sessionId, seq).catch(() => null);
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
    const pending = pendingSeqPersists.get(sessionId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingSeqPersists.delete(sessionId);
    }

    const session = await getSession(sessionId);
    if (!session) return false;

    const userId = session.userId.toString();

    await redis.del(`gateway:sessions:${sessionId}`);

    await redis.srem(`users:${userId}:gatewaySessions`, sessionId);

    sessionLRU.delete(sessionId);

    return true;
};
