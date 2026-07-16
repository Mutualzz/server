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
    eventName:
      | "BridgeChat"
      | "BridgeJoin"
      | "BridgeLeave"
      | "BridgeVoiceJoin"
      | "BridgeVoiceLeave"
      | "BridgePresence",
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

    if (event.type === "CHAT") {
      const data = event.data as BridgeChatPayload;
      // Sender already applied the REST response; skip echo for their own app chat.
      const skipUserId =
        data.source === "app" && data.userId ? data.userId : undefined;

      this.emitToRecipients(
        event.bridgeId,
        "BridgeChat",
        {
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
        skipUserId,
      );
      return;
    }

    if (event.type === "JOIN" || event.type === "LEAVE") {
      const data = event.data as BridgePlayerPayload;
      this.emitToRecipients(
        event.bridgeId,
        event.type === "JOIN" ? "BridgeJoin" : "BridgeLeave",
        {
          id: event.sourceId ?? data.sourceId ?? Snowflake.generate(),
          bridgeId: data.bridgeId,
          serverId: data.serverId,
          source: data.source,
          name: data.name,
          uuid: data.uuid,
          userId: data.userId,
          at: new Date().toISOString(),
        } satisfies GatewayBridgePlayerPayload,
      );
      return;
    }

    if (event.type === "VOICE_JOIN" || event.type === "VOICE_LEAVE") {
      const data = event.data as BridgeVoicePayload;
      this.emitToRecipients(
        event.bridgeId,
        event.type === "VOICE_JOIN" ? "BridgeVoiceJoin" : "BridgeVoiceLeave",
        {
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
      );
      return;
    }

    if (event.type === "PRESENCE") {
      const data = event.data as GatewayBridgePresencePayload;
      this.emitToRecipients(event.bridgeId, "BridgePresence", {
        bridgeId: data.bridgeId,
        players: data.players ?? [],
      } satisfies GatewayBridgePresencePayload);
    }
  }
}
