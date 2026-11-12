import type { Channel } from "amqplib";
import type WS from "ws";
import type { Codec } from "./Codec";
import type { Compressor } from "./Compressor";
import type { Compression, Encoding } from "./Negotation";
import type { RateLimitBucket } from "./RateLimit";

export interface MemberListWindow {
  key: string;
  channelId: string;
  parentId: string | null;
  channelSignature: string;
  parentSignature: string | null;
}

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
  isAlive?: boolean;
  sequence: number;
  events: Record<string, undefined | (() => unknown)>;

  encoding?: Encoding;
  compress?: Compression;

  codec?: Codec;
  compressor?: Compressor;

  rateLimits: Map<string, RateLimitBucket>;
  memberListWindows?: Map<string, MemberListWindow>;
  presences?: Map<string, Set<string>>;
  presenceSubs?: Set<string>;
  userSubscriptions?: Record<string, () => unknown>;
}
