import crypto from "crypto";
import { redis } from "@mutualzz/util/Redis.ts";
import { base64UrlEncode } from "@mutualzz/util/Common.ts";
import { Snowflake } from "@mutualzz/util/Snowflake.ts";

export interface VoiceSession {
  sessionId: string;
  userId: string;
  roomId: string;
  tokenId: string;
  createdAt: number;
}

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
  const tokenId = crypto.randomUUID();

  const voiceSession: VoiceSession = {
    sessionId,
    userId: normalizedUserId,
    roomId,
    createdAt: Date.now(),
    tokenId,
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

  return voiceSession;
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

  const data = `${base64UrlUserId}.${base64UrlSessionId}.${base64UrlRoomId}.${base64UrlTokenId}.${base64UrlTimestamp}`;
  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac("sha256", process.env.SECRET as string)
      .update(data)
      .digest(),
  );

  if (expectedSignature !== signature) return null;

  const raw = await redis.get(`voice:sessions:${token}`);
  if (!raw) return null;

  const session = JSON.parse(raw) as VoiceSession | null;
  if (!session) return null;

  return session;
};
