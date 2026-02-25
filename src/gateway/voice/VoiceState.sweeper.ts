import type { Snowflake } from "@mutualzz/types";
import { emitEvent, redis } from "@mutualzz/util";
import {
    VOICE_EXP_ZSET_KEY,
    VOICE_SWEEP_BATCH_SIZE,
    VOICE_SWEEP_EVERY_MS,
    VOICE_SWEEP_LOCK_KEY,
    VOICE_SWEEP_LOCK_TTL_MS,
} from "./VoiceState.constants";
import { lastKey, membersKey, stateKey } from "./VoiceState.util.ts";

export class VoiceStateSweeper {
    private static intervalHandle: NodeJS.Timeout | null = null;

    static start(instanceId: string) {
        if (this.intervalHandle) return;

        this.intervalHandle = setInterval(() => {
            void this.runOnce(instanceId);
        }, VOICE_SWEEP_EVERY_MS);
    }

    private static async acquireLock(instanceId: string) {
        const result = await redis.set(
            VOICE_SWEEP_LOCK_KEY,
            instanceId,
            "PX",
            VOICE_SWEEP_LOCK_TTL_MS,
            "NX",
        );
        return result === "OK";
    }

    private static async runOnce(instanceId: string) {
        const hasLock = await this.acquireLock(instanceId);
        if (!hasLock) return;

        const now = Date.now();

        const expiredUserIds = (await redis.zrangebyscore(
            VOICE_EXP_ZSET_KEY,
            0,
            now,
            "LIMIT",
            0,
            VOICE_SWEEP_BATCH_SIZE,
        )) as Snowflake[];

        if (!expiredUserIds.length) return;

        for (const userId of expiredUserIds) {
            const stillAlive = await redis.get(stateKey(userId));
            if (stillAlive) {
                await redis.zadd(
                    VOICE_EXP_ZSET_KEY,
                    String(Date.now() + 30_000),
                    userId,
                );
                continue;
            }

            const lastRaw = await redis.get(lastKey(userId));
            if (lastRaw) {
                try {
                    const last = JSON.parse(lastRaw) as {
                        spaceId: Snowflake;
                        channelId: Snowflake | null;
                    };

                    if (last.spaceId && last.channelId) {
                        await redis.srem(
                            membersKey(last.spaceId, last.channelId),
                            userId,
                        );

                        await emitEvent({
                            space_id: last.spaceId,
                            event: "VoiceStateUpdate",
                            data: {
                                userId,
                                spaceId: last.spaceId,
                                channelId: null,
                            },
                        });
                    }
                } catch {}
            }

            await redis.zrem(VOICE_EXP_ZSET_KEY, userId);
        }
    }
}
