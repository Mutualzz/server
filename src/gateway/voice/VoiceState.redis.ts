import type { Snowflake } from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import {
  VOICE_ACTIVE_SESSION_TTL_SECONDS,
  VOICE_EXP_ZSET_KEY,
  VOICE_LAST_TTL_SECONDS,
  VOICE_STATE_TTL_SECONDS,
} from "./VoiceState.constants";
import type { VoiceState } from "./VoiceState.types";
import { lastKey, stateKey, voiceScopeKey } from "./VoiceState.util";

interface ActiveVoiceSession {
  userId: Snowflake;
  sessionId: string;
  roomId: string;
  tokenId: string;
  updatedAt: number;
}

export class VoiceStateRedis {
  static async getState(userId: Snowflake): Promise<VoiceState | null> {
    const raw = await redis.get(stateKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VoiceState;
    } catch {
      return null;
    }
  }

  static activeSessionKey(userId: Snowflake) {
    return `voice:activeSession:${userId}`;
  }

  static async getActiveSession(
    userId: Snowflake,
  ): Promise<ActiveVoiceSession | null> {
    const raw = await redis.get(this.activeSessionKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ActiveVoiceSession;
    } catch {
      return null;
    }
  }

  static async setActiveSession(
    session: ActiveVoiceSession,
    ttlSeconds = VOICE_ACTIVE_SESSION_TTL_SECONDS,
  ) {
    await redis.set(
      this.activeSessionKey(session.userId),
      JSON.stringify(session),
      "EX",
      ttlSeconds,
    );
  }

  static async touchActiveSession(
    userId: Snowflake,
    ttlSeconds = VOICE_ACTIVE_SESSION_TTL_SECONDS,
  ) {
    const key = this.activeSessionKey(userId);
    const exists = await redis.exists(key);
    if (!exists) return false;
    await redis.expire(key, ttlSeconds);
    return true;
  }

  static async clearActiveSession(userId: Snowflake, tokenId?: string) {
    const current = await this.getActiveSession(userId);
    if (!current) return;
    if (tokenId && current.tokenId !== tokenId) return;

    const activeKey = this.activeSessionKey(userId);
    const currentTokenKey = `voice:currentToken:${userId}`;
    const expectedActive = JSON.stringify(current);

    await redis.eval(
      `
      if redis.call("GET", KEYS[1]) ~= ARGV[1] then
        return 0
      end
      local currentToken = redis.call("GET", KEYS[2])
      redis.call("DEL", KEYS[1])
      redis.call("DEL", KEYS[2])
      if currentToken then
        redis.call("DEL", "voice:sessions:" .. currentToken)
      end
      return 1
      `,
      2,
      activeKey,
      currentTokenKey,
      expectedActive,
    );
  }

  static async listChannelStates(
    spaceId: Snowflake | null,
    channelId: Snowflake,
  ): Promise<VoiceState[]> {
    const scopeKey = voiceScopeKey(spaceId, channelId);
    const userIds = await redis.smembers(scopeKey);
    if (!userIds.length) return [];

    const pipeline = redis.pipeline();
    for (const userId of userIds) {
      pipeline.get(stateKey(userId));
    }
    const results = await pipeline.exec();

    const out: VoiceState[] = [];
    for (const [, raw] of results ?? []) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw as string) as VoiceState;
        if (
          String(parsed.channelId) === String(channelId) &&
          (spaceId == null
            ? parsed.spaceId == null
            : String(parsed.spaceId) === String(spaceId))
        ) {
          out.push(parsed);
        }
      } catch {
        // Ignore errors
      }
    }

    return out;
  }

  static async upsertState(state: VoiceState) {
    const nextScopeKey =
      state.channelId != null
        ? voiceScopeKey(state.spaceId, state.channelId)
        : null;

    const expireAtMs = Date.now() + VOICE_STATE_TTL_SECONDS * 1000;

    const lastJson = JSON.stringify({
      spaceId: state.spaceId,
      channelId: state.channelId,
      updatedAt: state.updatedAt,
    });

    await redis.eval(
      `
      local raw = redis.call("GET", KEYS[1])
      if raw then
        local ok, previous = pcall(cjson.decode, raw)
        if ok and previous and previous.channelId ~= nil and type(previous.channelId) ~= "userdata" then
          local previousScope
          if previous.spaceId ~= nil and type(previous.spaceId) ~= "userdata" then
            previousScope = "voice:space:" .. tostring(previous.spaceId) .. ":channel:" .. tostring(previous.channelId)
          else
            previousScope = "voice:channel:" .. tostring(previous.channelId)
          end
          redis.call("SREM", previousScope, ARGV[1])
        end
      end
      if ARGV[2] ~= "" then
        redis.call("SADD", ARGV[2], ARGV[1])
      end
      redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
      redis.call("SET", KEYS[2], ARGV[5], "EX", ARGV[6])
      redis.call("ZADD", KEYS[3], ARGV[7], ARGV[1])
      return 1
      `,
      3,
      stateKey(state.userId),
      lastKey(state.userId),
      VOICE_EXP_ZSET_KEY,
      String(state.userId),
      nextScopeKey ?? "",
      JSON.stringify(state),
      String(VOICE_STATE_TTL_SECONDS),
      lastJson,
      String(VOICE_LAST_TTL_SECONDS),
      String(expireAtMs),
    );
  }

  static async touchMinecraftState(params: {
    userId: Snowflake;
    spaceId: Snowflake | null;
    channelId: Snowflake;
    updatedAt: number;
  }) {
    const expireAtMs = params.updatedAt + VOICE_STATE_TTL_SECONDS * 1000;
    const lastJson = JSON.stringify({
      spaceId: params.spaceId,
      channelId: params.channelId,
      updatedAt: params.updatedAt,
    });

    const result = await redis.eval(
      `
      local raw = redis.call("GET", KEYS[1])
      if not raw then
        return 0
      end
      local ok, state = pcall(cjson.decode, raw)
      if not ok or not state then
        return 0
      end
      if state.client ~= "minecraft" then
        return 0
      end
      if state.channelId == nil or type(state.channelId) == "userdata" then
        return 0
      end
      if tostring(state.channelId) ~= ARGV[1] then
        return 0
      end
      local currentSpace = (state.spaceId ~= nil and type(state.spaceId) ~= "userdata") and tostring(state.spaceId) or ""
      if currentSpace ~= ARGV[2] then
        return 0
      end
      state.updatedAt = tonumber(ARGV[3])
      redis.call("SET", KEYS[1], cjson.encode(state), "EX", ARGV[4])
      redis.call("SET", KEYS[2], ARGV[5], "EX", ARGV[6])
      redis.call("ZADD", KEYS[3], ARGV[7], ARGV[8])
      return 1
      `,
      3,
      stateKey(params.userId),
      lastKey(params.userId),
      VOICE_EXP_ZSET_KEY,
      String(params.channelId),
      params.spaceId == null ? "" : String(params.spaceId),
      String(params.updatedAt),
      String(VOICE_STATE_TTL_SECONDS),
      lastJson,
      String(VOICE_LAST_TTL_SECONDS),
      String(expireAtMs),
      String(params.userId),
    );

    return result === 1 || result === "1";
  }

  static async removeState(params: {
    userId: Snowflake;
    spaceId: Snowflake | null;
    channelId: Snowflake | null;
    sessionId?: string | null;
  }) {
    const result = await redis.eval(
      `
      local raw = redis.call("GET", KEYS[1])
      if not raw then
        return 0
      end
      local ok, state = pcall(cjson.decode, raw)
      if not ok or not state then
        redis.call("DEL", KEYS[1])
        redis.call("ZREM", KEYS[3], ARGV[1])
        return 0
      end
      if ARGV[6] ~= "" then
        if state.sessionId == nil or type(state.sessionId) == "userdata" then
          return 0
        end
        if tostring(state.sessionId) ~= ARGV[6] then
          return 0
        end
      end
      if ARGV[2] ~= "" then
        if state.channelId == nil or type(state.channelId) == "userdata" then
          return 0
        end
        if tostring(state.channelId) ~= ARGV[2] then
          return 0
        end
        local currentSpace = (state.spaceId ~= nil and type(state.spaceId) ~= "userdata") and tostring(state.spaceId) or ""
        if currentSpace ~= ARGV[3] then
          return 0
        end
        local scope
        if currentSpace ~= "" then
          scope = "voice:space:" .. currentSpace .. ":channel:" .. tostring(state.channelId)
        else
          scope = "voice:channel:" .. tostring(state.channelId)
        end
        redis.call("SREM", scope, ARGV[1])
      elseif state.channelId ~= nil and type(state.channelId) ~= "userdata" then
        local previousScope
        if state.spaceId ~= nil and type(state.spaceId) ~= "userdata" then
          previousScope = "voice:space:" .. tostring(state.spaceId) .. ":channel:" .. tostring(state.channelId)
        else
          previousScope = "voice:channel:" .. tostring(state.channelId)
        end
        redis.call("SREM", previousScope, ARGV[1])
      end
      redis.call("DEL", KEYS[1])
      redis.call("ZREM", KEYS[3], ARGV[1])
      redis.call("SET", KEYS[2], ARGV[4], "EX", ARGV[5])
      return 1
      `,
      3,
      stateKey(params.userId),
      lastKey(params.userId),
      VOICE_EXP_ZSET_KEY,
      String(params.userId),
      params.channelId == null ? "" : String(params.channelId),
      params.spaceId == null ? "" : String(params.spaceId),
      JSON.stringify({
        spaceId: params.spaceId,
        channelId: params.channelId,
        updatedAt: Date.now(),
      }),
      String(VOICE_LAST_TTL_SECONDS),
      params.sessionId == null ? "" : String(params.sessionId),
    );

    return result === 1 || result === "1";
  }

  static async removeStateBestEffort(userId: Snowflake) {
    const existing = await this.getState(userId);
    if (!existing) return;
    await this.removeState({
      userId,
      spaceId: existing.spaceId,
      channelId: existing.channelId,
      sessionId: null,
    });
  }
}
