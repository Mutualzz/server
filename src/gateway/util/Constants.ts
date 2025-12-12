export const HEARTBEAT_INTERVAL = 45000; // 45 seconds
export const DEFAULT_PORT = 4000;

export const OPCODE_LIMITS: Record<number, { limit: number; window: number }> =
    {
        1: { limit: 10, window: 60_000 }, // Heartbeat
        2: { limit: 1, window: 60_000 }, // Identify
        3: { limit: 5, window: 60_000 }, // Resume
    };
