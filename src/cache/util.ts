import { JSONReplacer, redis } from "@mutualzz/util";
import { caches, type CacheName, type CacheValue } from "./bundle";

export const getCache = async <T extends CacheName>(
    type: T,
    cacheKey: string | bigint,
): Promise<CacheValue<T> | null> => {
    cacheKey = cacheKeyPrefix(type, cacheKey);
    const value = caches[type]?.get(cacheKey);
    if (value !== undefined) return value as unknown as CacheValue<T>;

    if (!redis) return null;
    try {
        const redisVal = await redis.get(cacheKey);
        if (!redisVal) return null;
        const parsed = JSON.parse(
            redisVal,
            JSONReplacer,
        ) as unknown as CacheValue<T>;
        const cacheToSet = caches[type];
        if (!cacheToSet) return null;
        // @ts-expect-error-- TS cannot infer type here
        cacheToSet.set(cacheKey, parsed);
        return parsed;
    } catch {
        return null;
    }
};

export const cacheKeyPrefix = (type: CacheName, id: string | bigint) => {
    return `${type}:${id}`;
};

export const setCache = async <T extends CacheName>(
    type: T,
    cacheKey: string | bigint,
    value: CacheValue<T>,
    redisOpts: { withEx?: boolean } = { withEx: true },
) => {
    try {
        cacheKey = cacheKeyPrefix(type, cacheKey);
        caches[type]?.set(cacheKey, value as any);
        if (redis) {
            const ttlMs = caches[type]?.ttl;
            if (redisOpts.withEx && ttlMs && ttlMs > 0) {
                await redis.set(
                    cacheKey,
                    JSON.stringify(value, JSONReplacer),
                    "EX",
                    Math.floor(ttlMs / 1000),
                );
            } else {
                await redis.set(cacheKey, JSON.stringify(value, JSONReplacer));
            }
        }
    } catch {
        // ignore
    }
};

export const deleteCache = async (
    type: CacheName,
    cacheKey: string | bigint,
) => {
    try {
        cacheKey = cacheKeyPrefix(type, cacheKey);
        // Now perform deletion
        caches[type]?.delete(cacheKey);
        if (redis) {
            try {
                await redis.del(cacheKey);
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }
};

export const invalidateCache = async (
    type: CacheName,
    patternOrId: string | bigint,
) => {
    const prefix = cacheKeyPrefix(type, patternOrId);

    const lruCache = caches[type];
    if (lruCache) {
        for (const key of lruCache.keys()) {
            if (key.startsWith(prefix)) lruCache.delete(key);
        }
    }

    if (redis) {
        const redisPattern = `${prefix}*`;
        try {
            const keys = await redis.keys(redisPattern);
            if (keys && keys.length > 0) await redis.del(...keys);
        } catch {
            // ignore
        }
    }
};
