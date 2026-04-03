import type { Snowflake } from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import {
    VOICE_EXP_ZSET_KEY,
    VOICE_LAST_TTL_SECONDS,
    VOICE_STATE_TTL_SECONDS,
} from "./VoiceState.constants";
import type { VoiceState } from "./VoiceState.types";
import { lastKey, stateKey, voiceScopeKey } from "./VoiceState.util";

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

    static async listChannelStates(
        spaceId: Snowflake | null,
        channelId: Snowflake,
    ): Promise<VoiceState[]> {
        const scopeKey = voiceScopeKey(spaceId, channelId);
        const userIds = await redis.smembers(scopeKey);
        if (!userIds.length) return [];

        const pipeline = redis.pipeline();
        for (const userId of userIds) {
            pipeline.get(stateKey(userId as Snowflake));
        }
        const results = await pipeline.exec();

        const out: VoiceState[] = [];
        for (const [, raw] of results ?? []) {
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw as string) as VoiceState;
                if (
                    String(parsed.channelId) === String(channelId) &&
                    (spaceId == null ||
                        String(parsed.spaceId) === String(spaceId))
                ) {
                    out.push(parsed);
                }
            } catch {}
        }

        return out;
    }

    static async upsertState(state: VoiceState) {
        const previous = await this.getState(state.userId);

        const previousScopeKey =
            previous?.channelId != null
                ? voiceScopeKey(previous.spaceId, previous.channelId)
                : null;

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

        const transaction = redis.multi();

        if (previousScopeKey) transaction.srem(previousScopeKey, state.userId);
        if (nextScopeKey) transaction.sadd(nextScopeKey, state.userId);

        transaction.set(
            stateKey(state.userId),
            JSON.stringify(state),
            "EX",
            VOICE_STATE_TTL_SECONDS,
        );
        transaction.set(
            lastKey(state.userId),
            lastJson,
            "EX",
            VOICE_LAST_TTL_SECONDS,
        );

        transaction.zadd(VOICE_EXP_ZSET_KEY, String(expireAtMs), state.userId);

        await transaction.exec();
    }

    static async removeState(params: {
        userId: Snowflake;
        spaceId: Snowflake | null;
        channelId: Snowflake | null;
    }) {
        const transaction = redis.multi();

        if (params.channelId != null) {
            transaction.srem(
                voiceScopeKey(params.spaceId, params.channelId),
                params.userId,
            );
        }

        transaction.del(stateKey(params.userId));
        transaction.zrem(VOICE_EXP_ZSET_KEY, params.userId);

        transaction.set(
            lastKey(params.userId),
            JSON.stringify({
                spaceId: params.spaceId,
                channelId: params.channelId,
                updatedAt: Date.now(),
            }),
            "EX",
            VOICE_LAST_TTL_SECONDS,
        );

        await transaction.exec();
    }

    static async removeStateBestEffort(userId: Snowflake) {
        const existing = await this.getState(userId);
        if (!existing) return;
        await this.removeState({
            userId,
            spaceId: existing.spaceId,
            channelId: existing.channelId,
        });
    }
}
