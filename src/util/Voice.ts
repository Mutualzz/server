import { base64UrlEncode, redis, Snowflake } from "@mutualzz/util";
import crypto from "crypto";
import { LRUCache } from "lru-cache";

export interface VoiceSession {
    sessionId: string;
    userId: string;
    roomId: string;
    createdAt: number;
}

export const voiceSessionLRU = new LRUCache<string, VoiceSession>({
    max: 5000,
    ttl: 2 * 60 * 1000,
});

export const generateVoiceToken = (
    userId: string,
    sessionId: string,
    roomId: string,
) => {
    const timestamp = Snowflake.generate();

    const base64UrlUserId = base64UrlEncode(userId);
    const base64UrlSessionId = base64UrlEncode(sessionId);
    const base64UrlRoomId = base64UrlEncode(roomId);
    const base64UrlTimestamp = base64UrlEncode(timestamp);

    const data = `${base64UrlUserId}.${base64UrlSessionId}.${base64UrlRoomId}.${base64UrlTimestamp}`;
    const signature = base64UrlEncode(
        crypto
            .createHmac("sha256", process.env.SECRET as string)
            .update(data)
            .digest(),
    );

    return `${data}.${signature}`;
};

export const createVoiceSession = async (
    token: string,
    userId: string | bigint,
    sessionId: string,
    roomId: string,
    ttlSeconds = 300,
) => {
    const normalizedUserId = userId.toString();

    const voiceSession: VoiceSession = {
        sessionId,
        userId: normalizedUserId,
        roomId,
        createdAt: Date.now(),
    };

    await redis.set(
        `voice:sessions:${token}`,
        JSON.stringify(voiceSession),
        "EX",
        ttlSeconds,
    );

    await redis.set(
        `voice:currentToken:${normalizedUserId}`,
        token,
        "EX",
        ttlSeconds,
    );

    voiceSessionLRU.set(token, voiceSession);

    return voiceSession;
};

export const verifyVoiceToken = async (token: string) => {
    const parts = token.split(".");
    if (parts.length !== 5) return null;

    const [
        base64UrlUserId,
        base64UrlSessionId,
        base64UrlRoomId,
        base64UrlTimestamp,
        signature,
    ] = parts;

    if (
        !base64UrlUserId ||
        !base64UrlSessionId ||
        !base64UrlRoomId ||
        !base64UrlTimestamp ||
        !signature
    ) {
        return null;
    }

    const data = `${base64UrlUserId}.${base64UrlSessionId}.${base64UrlRoomId}.${base64UrlTimestamp}`;
    const expectedSignature = base64UrlEncode(
        crypto
            .createHmac("sha256", process.env.SECRET as string)
            .update(data)
            .digest(),
    );

    if (expectedSignature !== signature) return null;

    let session = voiceSessionLRU.get(token);

    if (!session) {
        const raw = await redis.get(`voice:sessions:${token}`);
        if (!raw) return null;

        session = JSON.parse(raw) as VoiceSession;
        if (!session) return null;

        voiceSessionLRU.set(token, session);
    }

    return session;
};
