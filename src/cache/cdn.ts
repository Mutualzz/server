import { LRUCache } from "lru-cache";

export const avatarCache = new LRUCache<string, Uint8Array>({
    max: 300,
    ttl: 1000 * 60 * 60 * 24, // 1 day
});

export const defaultAvatarCache = new LRUCache<string, Uint8Array>({
    max: 10,
    ttl: 1000 * 60 * 60 * 24 * 365, // 1 year (because we barely update this, unless we change default avatars)
});

export const spaceIconCache = new LRUCache<string, Uint8Array>({
    max: 300,
    ttl: 1000 * 60 * 60 * 24, // 1 day
});

export const channelIconCache = new LRUCache<string, Uint8Array>({
    max: 300,
    ttl: 1000 * 60 * 60 * 24, // 1 day
});
