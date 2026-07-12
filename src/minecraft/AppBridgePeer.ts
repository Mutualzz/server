import { bridgesTable, db } from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { emitEvent, fireAndForget, Snowflake } from "@mutualzz/util";
import { eq } from "drizzle-orm";
import { subscribeBridge } from "./BridgeBus";
import type {
  BridgeChatPayload,
  BridgeEvent,
  BridgePlayerPayload,
  BridgeSource,
  BridgeVoicePayload,
} from "./types";

const logger = new Logger({ tag: "AppBridgePeer" });

export interface GatewayBridgeChatPayload {
  id: string;
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  name: string;
  content: string;
  uuid?: string;
  userId?: string;
  avatarUrl?: string;
  at: string;
}

export interface GatewayBridgePlayerPayload {
  id: string;
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  name: string;
  uuid?: string;
  userId?: string;
  at: string;
}

export interface GatewayBridgeVoicePayload {
  id: string;
  bridgeId: string;
  serverId: string;
  source: BridgeSource;
  name: string;
  uuid?: string;
  userId?: string;
  channelId?: string;
  channelName?: string;
  room?: string;
  at: string;
}

export interface GatewayBridgePresencePayload {
  bridgeId: string;
  players: { uuid: string; name: string; serverId: string }[];
}

export class AppBridgePeer {
  private static unsubscribers = new Map<string, () => void>();
  private static ownersByBridge = new Map<string, string>();
  private static refreshTimer: ReturnType<typeof setInterval> | null = null;
  private static started = false;

  static async start() {
    if (this.started) return;
    this.started = true;
    await this.reloadBridges();
    this.refreshTimer = setInterval(() => {
      void this.reloadBridges();
    }, 60_000);
    logger.info("App bridge peer started");
  }

  static stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const unsub of this.unsubscribers.values()) unsub();
    this.unsubscribers.clear();
    this.ownersByBridge.clear();
    this.started = false;
  }

  static async reloadBridges() {
    const rows = await db.query.bridgesTable.findMany({
      where: eq(bridgesTable.status, 0),
    });

    const next = new Map<string, string>();
    for (const row of rows) {
      next.set(row.id.toString(), row.ownerId.toString());
    }

    for (const [bridgeId, unsub] of this.unsubscribers) {
      if (!next.has(bridgeId)) {
        unsub();
        this.unsubscribers.delete(bridgeId);
      }
    }

    this.ownersByBridge = next;

    for (const bridgeId of next.keys()) {
      if (this.unsubscribers.has(bridgeId)) continue;
      const unsub = subscribeBridge(bridgeId, (event) => {
        this.onBridgeEvent(event);
      });
      this.unsubscribers.set(bridgeId, unsub);
    }
  }

  private static onBridgeEvent(event: BridgeEvent) {
    const ownerId = this.ownersByBridge.get(event.bridgeId);
    if (!ownerId) return;

    // Sender already applied the REST response; skip owner echo for app chat
    // so the feed never shows the same outbound message twice.
    if (event.type === "CHAT") {
      const data = event.data as BridgeChatPayload;
      if (data.source === "app" && data.userId === ownerId) return;

      fireAndForget(() =>
        emitEvent({
          event: "BridgeChat",
          user_id: ownerId,
          data: {
            id: event.sourceId ?? data.sourceId ?? Snowflake.generate(),
            bridgeId: data.bridgeId,
            serverId: data.serverId,
            source: data.source,
            name: data.name,
            content: data.content,
            uuid: data.uuid,
            userId: data.userId,
            avatarUrl: data.avatarUrl,
            at: new Date().toISOString(),
          } satisfies GatewayBridgeChatPayload,
        }),
      );
      return;
    }

    if (event.type === "JOIN" || event.type === "LEAVE") {
      const data = event.data as BridgePlayerPayload;
      fireAndForget(() =>
        emitEvent({
          event: event.type === "JOIN" ? "BridgeJoin" : "BridgeLeave",
          user_id: ownerId,
          data: {
            id: event.sourceId ?? data.sourceId ?? Snowflake.generate(),
            bridgeId: data.bridgeId,
            serverId: data.serverId,
            source: data.source,
            name: data.name,
            uuid: data.uuid,
            userId: data.userId,
            at: new Date().toISOString(),
          } satisfies GatewayBridgePlayerPayload,
        }),
      );
      return;
    }

    if (event.type === "VOICE_JOIN" || event.type === "VOICE_LEAVE") {
      const data = event.data as BridgeVoicePayload;
      fireAndForget(() =>
        emitEvent({
          event:
            event.type === "VOICE_JOIN" ? "BridgeVoiceJoin" : "BridgeVoiceLeave",
          user_id: ownerId,
          data: {
            id: event.sourceId ?? data.sourceId ?? Snowflake.generate(),
            bridgeId: data.bridgeId,
            serverId: data.serverId,
            source: data.source,
            name: data.name,
            uuid: data.uuid,
            userId: data.userId,
            channelId: data.channelId,
            channelName: data.channelName,
            room: data.room,
            at: new Date().toISOString(),
          } satisfies GatewayBridgeVoicePayload,
        }),
      );
      return;
    }

    if (event.type === "PRESENCE") {
      const data = event.data as GatewayBridgePresencePayload;
      fireAndForget(() =>
        emitEvent({
          event: "BridgePresence",
          user_id: ownerId,
          data: {
            bridgeId: data.bridgeId,
            players: data.players ?? [],
          } satisfies GatewayBridgePresencePayload,
        }),
      );
    }
  }
}
