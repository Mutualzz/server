import type { WebSocket } from "./WebSocket";

export interface RateLimitBucket {
    count: number;
    resetAt: number;
}

export function checkGlobalRateLimit(
    socket: WebSocket,
    limit = 120,
    window = 60_000,
): boolean {
    const key = `${socket.sessionId}:global`;
    const now = Date.now();

    let bucket = socket.rateLimits.get(key);

    if (!bucket || bucket.resetAt < now) {
        bucket = { count: 0, resetAt: now + window };
        socket.rateLimits.set(key, bucket);
    }

    if (bucket.count >= limit) return false; // Rate limit exceeded

    bucket.count += 1;
    return true; // Within rate limit
}

export function checkRateLimit(
    socket: WebSocket,
    opcode: number,
    limit = 60,
    window = 60_000,
) {
    const key = `${socket.sessionId}:${opcode}`;
    const now = Date.now();

    let bucket = socket.rateLimits.get(key);

    if (!bucket || bucket.resetAt < now) {
        bucket = { count: 0, resetAt: now + window };
        socket.rateLimits.set(key, bucket);
    }

    if (bucket.count >= limit) return false; // Rate limit exceeded

    bucket.count += 1;
    return true; // Within rate limit
}
