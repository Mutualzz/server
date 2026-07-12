import { bridgeMessagesTable, bridgesTable, db } from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { Snowflake } from "@mutualzz/util";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type {
  BridgeChatPayload,
  BridgeEvent,
  BridgePlayerPayload,
  BridgeVoicePayload,
} from "./types";

const logger = new Logger({ tag: "BridgeMessages" });

const MAX_PER_BRIDGE = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface StoredBridgeMessage {
  id: string;
  bridgeId: string;
  serverId: string;
  source: "minecraft" | "discord" | "app";
  kind: "chat" | "join" | "leave" | "voice_join" | "voice_leave";
  name: string;
  content?: string;
  uuid?: string;
  userId?: string;
  avatarUrl?: string;
  at: string;
}

const trimHistory = async (bridgeId: bigint) => {
  try {
    await db.execute(sql`
      DELETE FROM bridge_messages
      WHERE id IN (
        SELECT id FROM bridge_messages
        WHERE "bridgeId" = ${bridgeId}
        ORDER BY "createdAt" DESC
        OFFSET ${MAX_PER_BRIDGE}
      )
    `);
  } catch (trimError) {
    logger.error(`Failed to trim bridge chat history: ${trimError}`);
  }
};

export const persistBridgeEvent = async (
  event: BridgeEvent,
  opts?: { skipPersist?: boolean },
) => {
  if (opts?.skipPersist) return;
  if (
    event.type !== "CHAT" &&
    event.type !== "JOIN" &&
    event.type !== "LEAVE" &&
    event.type !== "VOICE_JOIN" &&
    event.type !== "VOICE_LEAVE"
  ) {
    return;
  }

  const data = event.data as
    | BridgeChatPayload
    | BridgePlayerPayload
    | BridgeVoicePayload;
  const sourceKey =
    event.sourceId ?? data.sourceId ?? `${event.type}:${Snowflake.generate()}`;
  const id = BigInt(Snowflake.generate());
  const kind =
    event.type === "CHAT"
      ? "chat"
      : event.type === "JOIN"
        ? "join"
        : event.type === "LEAVE"
          ? "leave"
          : event.type === "VOICE_JOIN"
            ? "voice_join"
            : "voice_leave";
  const content =
    event.type === "CHAT"
      ? (data as BridgeChatPayload).content
      : event.type === "VOICE_JOIN" || event.type === "VOICE_LEAVE"
        ? ((data as BridgeVoicePayload).channelName ?? "")
        : "";

  try {
    await db
      .insert(bridgeMessagesTable)
      .values({
        id,
        bridgeId: BigInt(data.bridgeId),
        sourceKey,
        serverId: data.serverId,
        source: data.source,
        kind,
        name: data.name,
        content,
        uuid: data.uuid ?? null,
        userId: data.userId ?? null,
        avatarUrl:
          event.type === "CHAT"
            ? ((data as BridgeChatPayload).avatarUrl ?? null)
            : null,
      })
      .onConflictDoNothing({ target: bridgeMessagesTable.sourceKey });

    await db
      .update(bridgesTable)
      .set({ lastMessageId: sourceKey })
      .where(eq(bridgesTable.id, BigInt(data.bridgeId)));

    await trimHistory(BigInt(data.bridgeId));
  } catch (error) {
    logger.error(`Failed to persist bridge ${event.type}: ${error}`);
  }
};

/** @deprecated use persistBridgeEvent */
export const persistBridgeChat = (event: BridgeEvent) =>
  persistBridgeEvent(event);

export const listBridgeMessages = async (
  bridgeId: string,
  opts?: { limit?: number; before?: string },
): Promise<StoredBridgeMessage[]> => {
  const limit = Math.min(Math.max(1, opts?.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const conditions = [eq(bridgeMessagesTable.bridgeId, BigInt(bridgeId))];
  if (opts?.before) {
    const beforeRow = await db.query.bridgeMessagesTable.findFirst({
      where: eq(bridgeMessagesTable.sourceKey, opts.before),
    });
    if (beforeRow) {
      conditions.push(lt(bridgeMessagesTable.createdAt, beforeRow.createdAt));
    }
  }

  const rows = await db.query.bridgeMessagesTable.findMany({
    where: and(...conditions),
    orderBy: [
      desc(bridgeMessagesTable.createdAt),
      desc(bridgeMessagesTable.id),
    ],
    limit,
  });

  return [...rows].reverse().map((row) => ({
    id: row.sourceKey,
    bridgeId: row.bridgeId.toString(),
    serverId: row.serverId,
    source: row.source as StoredBridgeMessage["source"],
    kind: (row.kind as StoredBridgeMessage["kind"] | null) || "chat",
    name: row.name,
    content: row.content || undefined,
    uuid: row.uuid ?? undefined,
    userId: row.userId ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
    at: row.createdAt.toISOString(),
  }));
};
