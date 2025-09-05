import type { Channel } from "amqplib";
import type WS from "ws";

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
}
