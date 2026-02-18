import { GatewayOpcodes } from "@mutualzz/types";

export const HEARTBEAT_INTERVAL = 45000; // 45 seconds
export const DEFAULT_PORT = 4000;

export const OPCODE_LIMITS: Record<number, { limit: number; window: number }> =
    {
        [GatewayOpcodes.Heartbeat]: { limit: 10, window: 60_000 }, // Heartbeat
        [GatewayOpcodes.Identify]: { limit: 1, window: 60_000 }, // Identify
        [GatewayOpcodes.Resume]: { limit: 5, window: 60_000 }, // Resume
        [GatewayOpcodes.LazyRequest]: { limit: 20, window: 60_000 }, // LazyRequest
        [GatewayOpcodes.PresenceUpdate]: { limit: 6, window: 10_000 }, // Presence
    };
