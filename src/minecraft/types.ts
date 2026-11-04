export type BridgeSource = "minecraft" | "discord" | "app";

export interface BridgeChatPayload {
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  sourceId?: string;
  uuid?: string;
  name: string;
  content: string;
  userId?: string;
  /** Discord (or other) avatar URL when available */
  avatarUrl?: string;
}

export interface BridgePlayerPayload {
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  sourceId?: string;
  uuid: string;
  name: string;
  userId?: string;
}

export interface BridgeGameEventPayload extends BridgePlayerPayload {
  kind: "death" | "advancement";
  message: string;
}

/** Quiet announce when a player joins/leaves Mutualzz voice from Minecraft. */
export interface BridgeVoicePayload {
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  sourceId?: string;
  uuid: string;
  name: string;
  userId?: string;
  channelId?: string;
  /** Mutualzz voice channel display name */
  channelName?: string;
  /** In-game room key (binding slug) */
  room?: string;
}

export interface BridgePresencePayload {
  bridgeId: string;
  players: { uuid: string; name: string; serverId: string }[];
}

export interface BridgeLinkResultPayload {
  ok: boolean;
  userId: string;
  minecraftUuid: string;
  minecraftName: string;
}

export interface BridgeServerStatus {
  serverId: string;
  tps: number;
  mspt: number;
  maxPlayers: number;
  version: string;
  motd: string;
  updatedAt: string;
}

export interface BridgeServerStatusPayload {
  bridgeId: string;
  serverId: string;
  status: BridgeServerStatus | null;
}

interface BridgeEventOf<TType extends string, TData> {
  type: TType;
  bridgeId: string;
  sourceId?: string;
  data: TData;
}

export type PersistedBridgeEvent =
  | BridgeEventOf<"CHAT", BridgeChatPayload>
  | BridgeEventOf<"JOIN" | "LEAVE", BridgePlayerPayload>
  | BridgeEventOf<"VOICE_JOIN" | "VOICE_LEAVE", BridgeVoicePayload>
  | BridgeEventOf<"GAME_EVENT", BridgeGameEventPayload>;

export type BridgeEvent =
  | PersistedBridgeEvent
  | BridgeEventOf<"PRESENCE", BridgePresencePayload>
  | BridgeEventOf<"LINK_RESULT", BridgeLinkResultPayload>
  | BridgeEventOf<"SERVER_STATUS", BridgeServerStatusPayload>;

export type BridgeEventType =
  | BridgeEvent["type"]
  | "VOICE_RESULT"
  | "INVENTORY_WATCH";

const PERSISTED_EVENT_TYPES: ReadonlySet<BridgeEvent["type"]> = new Set([
  "CHAT",
  "JOIN",
  "LEAVE",
  "VOICE_JOIN",
  "VOICE_LEAVE",
  "GAME_EVENT",
]);

export const isPersistedBridgeEvent = (
  event: BridgeEvent,
): event is PersistedBridgeEvent => PERSISTED_EVENT_TYPES.has(event.type);

export const GAME_EVENT_EMOJI: Record<BridgeGameEventPayload["kind"], string> =
  {
    death: "💀",
    advancement: "🏆",
  };

export type MinecraftClientOp =
  | "identify"
  | "heartbeat"
  | "chat"
  | "join"
  | "leave"
  | "link"
  | "voice_join"
  | "voice_leave"
  | "voice_state"
  | "inventory"
  | "game_event"
  | "server_status";

export type MinecraftServerOp =
  | "hello"
  | "ready"
  | "heartbeat_ack"
  | "dispatch"
  | "error";

export interface MinecraftPayload {
  op: MinecraftClientOp | MinecraftServerOp;
  t?: BridgeEventType;
  d?: Record<string, unknown>;
}
