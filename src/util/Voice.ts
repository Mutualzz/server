import crypto from "crypto";
import { redis } from "@mutualzz/util/Redis.ts";
import { base64UrlEncode } from "@mutualzz/util/Common.ts";
import { Snowflake } from "@mutualzz/util/Snowflake.ts";

export const VOICE_SESSION_TTL_SECONDS = 28_800;

export interface VoiceSession {
  sessionId: string;
  userId: string;
  roomId: string;
  tokenId: string;
  createdAt: number;
}

const getVoiceSecret = () => {
  const secret = process.env.SECRET;
  if (!secret) {
    throw new Error("SECRET env var is required for voice tokens");
  }
  return secret;
};

const signaturesMatch = (expected: string, actual: string) => {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
};

export const generateVoiceToken = (
  userId: string,
  sessionId: string,
  roomId: string,
  tokenId: string,
) => {
  const timestamp = Snowflake.generate();

  const base64UrlUserId = base64UrlEncode(userId);
  const base64UrlSessionId = base64UrlEncode(sessionId);
  const base64UrlRoomId = base64UrlEncode(roomId);
  const base64UrlTokenId = base64UrlEncode(tokenId);
  const base64UrlTimestamp = base64UrlEncode(timestamp);

  const data = `${base64UrlUserId}.${base64UrlSessionId}.${base64UrlRoomId}.${base64UrlTokenId}.${base64UrlTimestamp}`;
  const signature = base64UrlEncode(
    crypto.createHmac("sha256", getVoiceSecret()).update(data).digest(),
  );

  return `${data}.${signature}`;
};

export const createVoiceSession = async (
  token: string,
  userId: string | bigint,
  sessionId: string,
  roomId: string,
  ttlSeconds = VOICE_SESSION_TTL_SECONDS,
  tokenId?: string,
) => {
  const normalizedUserId = userId.toString();

  const voiceSession: VoiceSession = {
    sessionId,
    userId: normalizedUserId,
    roomId,
    createdAt: Date.now(),
    tokenId: tokenId ?? crypto.randomUUID(),
  };

  const previousToken = await redis.get(
    `voice:currentToken:${normalizedUserId}`,
  );

  const transaction = redis.multi();
  if (previousToken && previousToken !== token) {
    transaction.del(`voice:sessions:${previousToken}`);
  }
  transaction.set(
    `voice:sessions:${token}`,
    JSON.stringify(voiceSession),
    "EX",
    ttlSeconds,
  );
  transaction.set(
    `voice:currentToken:${normalizedUserId}`,
    token,
    "EX",
    ttlSeconds,
  );
  await transaction.exec();

  return voiceSession;
};

export const touchVoiceSessionTtls = async (
  userId: string | bigint,
  ttlSeconds = VOICE_SESSION_TTL_SECONDS,
) => {
  const normalizedUserId = userId.toString();
  const token = await redis.get(`voice:currentToken:${normalizedUserId}`);
  if (!token) return false;

  await Promise.all([
    redis.expire(`voice:sessions:${token}`, ttlSeconds),
    redis.expire(`voice:currentToken:${normalizedUserId}`, ttlSeconds),
  ]);
  return true;
};

export const verifyVoiceToken = async (token: string) => {
  const parts = token.split(".");
  if (parts.length !== 6) return null;

  const [
    base64UrlUserId,
    base64UrlSessionId,
    base64UrlRoomId,
    base64UrlTokenId,
    base64UrlTimestamp,
    signature,
  ] = parts;

  if (
    !base64UrlUserId ||
    !base64UrlSessionId ||
    !base64UrlRoomId ||
    !base64UrlTokenId ||
    !base64UrlTimestamp ||
    !signature
  ) {
    return null;
  }

  let expectedSignature: string;
  try {
    const data = `${base64UrlUserId}.${base64UrlSessionId}.${base64UrlRoomId}.${base64UrlTokenId}.${base64UrlTimestamp}`;
    expectedSignature = base64UrlEncode(
      crypto.createHmac("sha256", getVoiceSecret()).update(data).digest(),
    );
  } catch {
    return null;
  }

  if (!signaturesMatch(expectedSignature, signature)) return null;

  const raw = await redis.get(`voice:sessions:${token}`);
  if (!raw) return null;

  const session = JSON.parse(raw) as VoiceSession | null;
  if (!session) return null;

  const currentToken = await redis.get(`voice:currentToken:${session.userId}`);
  if (!currentToken || currentToken !== token) return null;

  return session;
};
