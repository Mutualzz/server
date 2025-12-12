import type { Channel } from "amqplib";
import type WS from "ws";
import type { Codec } from "./Codec";
import type { Compressor } from "./Compressor";
import type { Compression, Encoding } from "./Negotation";
import type { RateLimitBucket } from "./RateLimit";

export interface WebSocket extends WS {
    listenOptions: {
        acknowledge: boolean;
        channel?: Channel & { queues?: unknown; ch?: number };
    };
    version: number;
    userId?: string;
    sessionId: string;
    token?: string;
    ipAddress?: string;
    userAgent?: string;
    heartbeatTimeout?: NodeJS.Timeout;
    readyTimeout?: NodeJS.Timeout;
    sequence: number;
    events: Record<string, undefined | (() => unknown)>;
    member_events: Record<string, () => unknown>;

    encoding?: Encoding;
    compress?: Compression;

    codec?: Codec;
    compressor?: Compressor;

    rateLimits: Map<string, RateLimitBucket>;
}
