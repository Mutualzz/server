import { createHash, randomBytes } from "node:crypto";
import { getMinecraftBridgeHubUrl } from "../tokens.ts";

export interface MinecraftAudioTokenRecord {
  token: string;
  userId: string;
  sessionId: string;
  minecraftUuid: string;
  createdAt: number;
  expiresAt: number;
}

const TOKEN_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const byToken = new Map<string, MinecraftAudioTokenRecord>();
const byUserId = new Map<string, string>();

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export const mintMinecraftAudioToken = (params: {
  userId: string;
  sessionId: string;
  minecraftUuid: string;
}): MinecraftAudioTokenRecord => {
  revokeMinecraftAudioTokenForUser(params.userId);

  const token = `mza_${randomBytes(24).toString("base64url")}`;
  const now = Date.now();
  const record: MinecraftAudioTokenRecord = {
    token,
    userId: params.userId,
    sessionId: params.sessionId,
    minecraftUuid: params.minecraftUuid,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  byToken.set(hash(token), record);
  byUserId.set(params.userId, hash(token));
  return record;
};

export const resolveMinecraftAudioToken = (
  token: string,
): MinecraftAudioTokenRecord | null => {
  const record = byToken.get(hash(token));
  if (!record) return null;
  if (record.expiresAt < Date.now()) {
    byToken.delete(hash(token));
    if (byUserId.get(record.userId) === hash(token)) {
      byUserId.delete(record.userId);
    }
    return null;
  }
  return record;
};

export const revokeMinecraftAudioTokenForUser = (userId: string) => {
  const key = byUserId.get(userId);
  if (!key) return;
  byUserId.delete(userId);
  byToken.delete(key);
};

/** Public WS URL the Fabric mod uses for PCM relay (same host as the bridge). */
export const getMinecraftAudioWsUrl = () => {
  if (process.env.MC_AUDIO_WS_URL?.trim()) {
    return process.env.MC_AUDIO_WS_URL.trim().replace(/\/$/, "");
  }
  return `${getMinecraftBridgeHubUrl()}/minecraft-voice-audio`;
};
