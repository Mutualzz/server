import { type APICall, type Snowflake } from "@mutualzz/types";
import { redis } from "@mutualzz/util";

const CALL_TTL_SECONDS = 24 * 60 * 60;
const CALL_CANCEL_INTENT_TTL_SECONDS = 60;
const CALL_ACTIVE_SET = "call:active";
const CALL_SWEEP_LOCK_KEY = "call:sweeper:lock";
const CALL_SWEEP_LOCK_TTL_MS = 15_000;
const CALL_SWEEP_EVERY_MS = 5_000;
const CALL_END_LOCK_TTL_MS = 30_000;

function callKey(callId: Snowflake) {
  return `call:${callId}`;
}

function channelCallKey(channelId: Snowflake) {
  return `call:channel:${channelId}`;
}

function ringingKey(userId: Snowflake) {
  return `call:ringing:${userId}`;
}

function cancelIntentKey(channelId: Snowflake) {
  return `call:cancel-intent:${channelId}`;
}

export class CallRedis {
  static readonly SWEEP_EVERY_MS = CALL_SWEEP_EVERY_MS;
  static readonly SWEEP_LOCK_KEY = CALL_SWEEP_LOCK_KEY;
  static readonly SWEEP_LOCK_TTL_MS = CALL_SWEEP_LOCK_TTL_MS;

  static async get(callId: Snowflake): Promise<APICall | null> {
    const raw = await redis.get(callKey(callId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as APICall;
    } catch {
      return null;
    }
  }

  static async getByChannel(channelId: Snowflake): Promise<APICall | null> {
    const callId = await redis.get(channelCallKey(channelId));
    if (!callId) return null;
    const call = await this.get(callId);
    if (!call) {
      await redis
        .multi()
        .del(channelCallKey(channelId))
        .srem(CALL_ACTIVE_SET, callId)
        .exec();
      return null;
    }
    return call;
  }

  static async listActiveCallIds(): Promise<Snowflake[]> {
    return (await redis.smembers(CALL_ACTIVE_SET)) as Snowflake[];
  }

  static async dropActive(callId: Snowflake) {
    await redis.srem(CALL_ACTIVE_SET, callId);
  }

  static async listCallsForChannels(
    channelIds: Snowflake[],
  ): Promise<APICall[]> {
    const calls: APICall[] = [];
    for (const channelId of channelIds) {
      const call = await this.getByChannel(channelId);
      if (call) calls.push(call);
    }
    return calls;
  }

  static async create(call: APICall): Promise<boolean> {
    const set = await redis.set(
      channelCallKey(call.channelId),
      call.id,
      "EX",
      CALL_TTL_SECONDS,
      "NX",
    );
    if (set !== "OK") return false;

    await redis
      .multi()
      .set(callKey(call.id), JSON.stringify(call), "EX", CALL_TTL_SECONDS)
      .sadd(CALL_ACTIVE_SET, call.id)
      .exec();

    if (!call.silent) {
      const multi = redis.multi();
      for (const userId of call.ringing) {
        multi.sadd(ringingKey(userId), call.id);
        multi.expire(ringingKey(userId), CALL_TTL_SECONDS);
      }
      await multi.exec();
    }

    return true;
  }

  static async save(call: APICall) {
    const ended = await redis.get(`call:end:${call.id}`);
    if (ended) return false;

    const currentId = await redis.get(channelCallKey(call.channelId));
    if (String(currentId) !== String(call.id)) return false;

    await redis
      .multi()
      .set(callKey(call.id), JSON.stringify(call), "EX", CALL_TTL_SECONDS)
      .expire(channelCallKey(call.channelId), CALL_TTL_SECONDS)
      .sadd(CALL_ACTIVE_SET, call.id)
      .exec();
    return true;
  }

  static async removeFromRinging(callId: Snowflake, userId: Snowflake) {
    await redis.srem(ringingKey(userId), callId);
  }

  static async addToRinging(callId: Snowflake, userId: Snowflake) {
    await redis
      .multi()
      .sadd(ringingKey(userId), callId)
      .expire(ringingKey(userId), CALL_TTL_SECONDS)
      .exec();
  }

  static async clearRinging(call: APICall) {
    if (!call.ringing.length) return;
    const multi = redis.multi();
    for (const userId of call.ringing) {
      multi.srem(ringingKey(userId), call.id);
    }
    await multi.exec();
  }

  static async delete(call: APICall) {
    await this.clearRinging(call);
    await redis
      .multi()
      .del(callKey(call.id))
      .del(channelCallKey(call.channelId))
      .srem(CALL_ACTIVE_SET, call.id)
      .exec();
  }

  static async acquireSweepLock(instanceId: string) {
    const result = await redis.set(
      CALL_SWEEP_LOCK_KEY,
      instanceId,
      "PX",
      CALL_SWEEP_LOCK_TTL_MS,
      "NX",
    );
    return result === "OK";
  }

  static async claimEnd(callId: Snowflake) {
    const result = await redis.set(
      `call:end:${callId}`,
      "1",
      "PX",
      CALL_END_LOCK_TTL_MS,
      "NX",
    );
    return result === "OK";
  }

  static async releaseEndClaim(callId: Snowflake) {
    await redis.del(`call:end:${callId}`);
  }

  static async setCancelIntent(channelId: Snowflake, userId: Snowflake) {
    await redis.set(
      cancelIntentKey(channelId),
      String(userId),
      "EX",
      CALL_CANCEL_INTENT_TTL_SECONDS,
    );
  }

  static async consumeCancelIntent(
    channelId: Snowflake,
  ): Promise<string | null> {
    const key = cancelIntentKey(channelId);
    const userId = await redis.get(key);
    if (!userId) return null;
    await redis.del(key);
    return String(userId);
  }

  static async clearCancelIntent(channelId: Snowflake) {
    await redis.del(cancelIntentKey(channelId));
  }
}
