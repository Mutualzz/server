import { createHash, randomBytes } from "node:crypto";
import { redis } from "@mutualzz/util";
import { INSTANCE_ID } from "../../util/InstanceId.ts";
import { getMinecraftBridgeHubUrl } from "../tokens.ts";

export interface MinecraftAudioTokenRecord {
  token: string;
  userId: string;
  sessionId: string;
  minecraftUuid: string;
  instanceId: string;
  audioWsUrl: string;
  createdAt: number;
  expiresAt: number;
}

export interface MinecraftVoicePeerLocation {
  userId: string;
  instanceId: string;
  audioWsUrl: string;
  sessionId: string;
  minecraftUuid: string;
  updatedAt: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 6;
const PEER_TTL_SECONDS = 60 * 60 * 6;

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const tokenKey = (tokenHash: string) => `voice:mc:audioToken:${tokenHash}`;
const userTokenKey = (userId: string) => `voice:mc:audioTokenByUser:${userId}`;
const peerLocationKey = (userId: string) => `voice:mc:peer:${userId}`;

const getInstanceId = () => INSTANCE_ID;

export const getMinecraftAudioWsUrl = () => {
  if (process.env.MC_AUDIO_WS_URL?.trim()) {
    return process.env.MC_AUDIO_WS_URL.trim().replace(/\/$/, "");
  }
  return `${getMinecraftBridgeHubUrl()}/minecraft-voice-audio`;
};

export const mintMinecraftAudioToken = async (params: {
  userId: string;
  sessionId: string;
  minecraftUuid: string;
}): Promise<MinecraftAudioTokenRecord> => {
  await revokeMinecraftAudioTokenForUser(params.userId);

  const token = `mza_${randomBytes(24).toString("base64url")}`;
  const now = Date.now();
  const tokenHash = hash(token);
  const audioWsUrl = getMinecraftAudioWsUrl();
  const record: MinecraftAudioTokenRecord = {
    token,
    userId: params.userId,
    sessionId: params.sessionId,
    minecraftUuid: params.minecraftUuid,
    instanceId: getInstanceId(),
    audioWsUrl,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_SECONDS * 1000,
  };

  const stored = {
    userId: record.userId,
    sessionId: record.sessionId,
    minecraftUuid: record.minecraftUuid,
    instanceId: record.instanceId,
    audioWsUrl: record.audioWsUrl,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };

  const multi = redis.multi();
  multi.set(
    tokenKey(tokenHash),
    JSON.stringify(stored),
    "EX",
    TOKEN_TTL_SECONDS,
  );
  multi.set(userTokenKey(params.userId), tokenHash, "EX", TOKEN_TTL_SECONDS);
  await multi.exec();

  return record;
};

export const resolveMinecraftAudioToken = async (
  token: string,
): Promise<MinecraftAudioTokenRecord | null> => {
  if (!token) return null;
  const tokenHash = hash(token);
  const raw = await redis.get(tokenKey(tokenHash));
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as Omit<MinecraftAudioTokenRecord, "token">;
    if (stored.expiresAt < Date.now()) {
      await revokeMinecraftAudioTokenForUser(stored.userId);
      return null;
    }
    return { ...stored, token };
  } catch {
    return null;
  }
};

export const revokeMinecraftAudioTokenForUser = async (userId: string) => {
  const tokenHash = await redis.get(userTokenKey(userId));
  const multi = redis.multi();
  multi.del(userTokenKey(userId));
  if (tokenHash) multi.del(tokenKey(tokenHash));
  await multi.exec();
};

export const registerMinecraftVoicePeerLocation = async (params: {
  userId: string;
  sessionId: string;
  minecraftUuid: string;
}) => {
  const location: MinecraftVoicePeerLocation = {
    userId: params.userId,
    instanceId: getInstanceId(),
    audioWsUrl: getMinecraftAudioWsUrl(),
    sessionId: params.sessionId,
    minecraftUuid: params.minecraftUuid,
    updatedAt: Date.now(),
  };

  await redis.set(
    peerLocationKey(params.userId),
    JSON.stringify(location),
    "EX",
    PEER_TTL_SECONDS,
  );

  return location;
};

export const touchMinecraftVoicePeerLocation = async (userId: string) => {
  await redis.expire(peerLocationKey(userId), PEER_TTL_SECONDS);
};

export const getMinecraftVoicePeerLocation = async (
  userId: string,
): Promise<MinecraftVoicePeerLocation | null> => {
  const raw = await redis.get(peerLocationKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MinecraftVoicePeerLocation;
  } catch {
    return null;
  }
};

export const clearMinecraftVoicePeerLocation = async (userId: string) => {
  await redis.del(peerLocationKey(userId));
};
