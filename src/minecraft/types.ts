export type BridgeSource = "minecraft" | "discord" | "app";

export type BridgeEventType =
  | "CHAT"
  | "JOIN"
  | "LEAVE"
  | "LINK_RESULT"
  | "VOICE_RESULT"
  | "VOICE_JOIN"
  | "VOICE_LEAVE"
  | "PRESENCE";

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

export interface BridgeEvent<T = unknown> {
  type: BridgeEventType;
  bridgeId: string;
  sourceId?: string;
  data: T;
}

export type MinecraftClientOp =
  | "identify"
  | "heartbeat"
  | "chat"
  | "join"
  | "leave"
  | "link"
  | "voice_join"
  | "voice_leave"
  | "voice_state";

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
