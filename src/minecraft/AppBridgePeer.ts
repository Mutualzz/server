import {
  bridgeMembersTable,
  bridgesTable,
  db,
  spaceMembersTable,
} from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { emitEvent, fireAndForget, Snowflake } from "@mutualzz/util";
import { eq, inArray } from "drizzle-orm";
import { subscribeBridge } from "./BridgeBus";
import type { BridgeEvent, BridgeSource, PersistedBridgeEvent } from "./types";

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

export interface GatewayBridgeGameEventPayload extends GatewayBridgePlayerPayload {
  kind: "death" | "advancement";
  content: string;
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

type GatewayBridgeEventName =
  | "BridgeChat"
  | "BridgeJoin"
  | "BridgeLeave"
  | "BridgeVoiceJoin"
  | "BridgeVoiceLeave"
  | "BridgePresence"
  | "BridgeGameEvent"
  | "BridgeServerStatus";

const GATEWAY_EVENT_BY_TYPE = {
  JOIN: "BridgeJoin",
  LEAVE: "BridgeLeave",
  VOICE_JOIN: "BridgeVoiceJoin",
  VOICE_LEAVE: "BridgeVoiceLeave",
} as const satisfies Record<string, GatewayBridgeEventName>;

const gatewayBase = (event: PersistedBridgeEvent) => ({
  id: event.sourceId ?? event.data.sourceId ?? Snowflake.generate(),
  bridgeId: event.data.bridgeId,
  serverId: event.data.serverId,
  source: event.data.source,
  name: event.data.name,
  uuid: event.data.uuid,
  userId: event.data.userId,
  at: new Date().toISOString(),
});

export class AppBridgePeer {
  private static unsubscribers = new Map<string, () => void>();
  /** bridgeId → Mutualzz user ids that should receive live events */
  private static recipientsByBridge = new Map<string, Set<string>>();
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
    this.recipientsByBridge.clear();
    this.started = false;
  }

  static addRecipient(bridgeId: string, userId: string) {
    const set = this.recipientsByBridge.get(bridgeId) ?? new Set<string>();
    set.add(userId);
    this.recipientsByBridge.set(bridgeId, set);
  }

  static removeRecipient(bridgeId: string, userId: string) {
    const set = this.recipientsByBridge.get(bridgeId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) this.recipientsByBridge.delete(bridgeId);
  }

  static async reloadBridges() {
    const rows = await db.query.bridgesTable.findMany({
      where: eq(bridgesTable.status, 0),
    });

    const bridgeIds = rows.map((r) => r.id);
    const spaceIds = [...new Set(rows.map((r) => r.spaceId))];

    const [memberRows, spaceMemberRows] = await Promise.all([
      bridgeIds.length === 0
        ? Promise.resolve([])
        : db.query.bridgeMembersTable.findMany({
            where: inArray(bridgeMembersTable.bridgeId, bridgeIds),
          }),
      spaceIds.length === 0
        ? Promise.resolve([])
        : db.query.spaceMembersTable.findMany({
            where: inArray(spaceMembersTable.spaceId, spaceIds),
          }),
    ]);

    const bridgeMembersByBridge = new Map<string, Set<string>>();
    for (const m of memberRows) {
      const key = m.bridgeId.toString();
      const set = bridgeMembersByBridge.get(key) ?? new Set<string>();
      set.add(m.userId.toString());
      bridgeMembersByBridge.set(key, set);
    }

    const spaceMembersBySpace = new Map<string, Set<string>>();
    for (const m of spaceMemberRows) {
      const key = m.spaceId.toString();
      const set = spaceMembersBySpace.get(key) ?? new Set<string>();
      set.add(m.userId.toString());
      spaceMembersBySpace.set(key, set);
    }

    const next = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = row.id.toString();
      const set = new Set<string>();
      for (const uid of spaceMembersBySpace.get(row.spaceId.toString()) ?? [])
        set.add(uid);
      for (const uid of bridgeMembersByBridge.get(id) ?? []) set.add(uid);
      next.set(id, set);
    }

    for (const [bridgeId, unsub] of this.unsubscribers) {
      if (!next.has(bridgeId)) {
        unsub();
        this.unsubscribers.delete(bridgeId);
      }
    }

    this.recipientsByBridge = next;

    for (const bridgeId of next.keys()) {
      if (this.unsubscribers.has(bridgeId)) continue;
      const unsub = subscribeBridge(bridgeId, (event) => {
        this.onBridgeEvent(event);
      });
      this.unsubscribers.set(bridgeId, unsub);
    }
  }

  private static emitToRecipients(
    bridgeId: string,
    eventName: GatewayBridgeEventName,
    data: unknown,
    skipUserId?: string,
  ) {
    const recipients = this.recipientsByBridge.get(bridgeId);
    if (!recipients || recipients.size === 0) return;

    for (const userId of recipients) {
      if (skipUserId && userId === skipUserId) continue;
      fireAndForget(() =>
        emitEvent({
          event: eventName,
          user_id: userId,
          data,
        }),
      );
    }
  }

  private static onBridgeEvent(event: BridgeEvent) {
    if (!this.recipientsByBridge.has(event.bridgeId)) return;

    switch (event.type) {
      case "CHAT": {
        const skipUserId =
          event.data.source === "app" ? event.data.userId : undefined;
        this.emitToRecipients(
          event.bridgeId,
          "BridgeChat",
          {
            ...gatewayBase(event),
            content: event.data.content,
            avatarUrl: event.data.avatarUrl,
          } satisfies GatewayBridgeChatPayload,
          skipUserId,
        );
        return;
      }
      case "JOIN":
      case "LEAVE":
        this.emitToRecipients(
          event.bridgeId,
          GATEWAY_EVENT_BY_TYPE[event.type],
          gatewayBase(event) satisfies GatewayBridgePlayerPayload,
        );
        return;
      case "VOICE_JOIN":
      case "VOICE_LEAVE":
        this.emitToRecipients(
          event.bridgeId,
          GATEWAY_EVENT_BY_TYPE[event.type],
          {
            ...gatewayBase(event),
            channelId: event.data.channelId,
            channelName: event.data.channelName,
            room: event.data.room,
          } satisfies GatewayBridgeVoicePayload,
        );
        return;
      case "GAME_EVENT":
        this.emitToRecipients(event.bridgeId, "BridgeGameEvent", {
          ...gatewayBase(event),
          kind: event.data.kind,
          content: event.data.message,
        } satisfies GatewayBridgeGameEventPayload);
        return;
      case "PRESENCE":
        this.emitToRecipients(event.bridgeId, "BridgePresence", {
          bridgeId: event.data.bridgeId,
          players: event.data.players ?? [],
        } satisfies GatewayBridgePresencePayload);
        return;
      case "SERVER_STATUS":
        this.emitToRecipients(event.bridgeId, "BridgeServerStatus", event.data);
        return;
      case "LINK_RESULT":
        return;
    }
  }
}
