import { listenEvent, type EventOpts } from "@mutualzz/util";
import {
  GatewayOpcodes,
  RelationshipType,
  type GatewayPayload,
} from "@mutualzz/types";
import {
  channelRecipientsTable,
  db,
  relationshipsTable,
  spaceMembersTable,
} from "@mutualzz/database";
import { and, eq, sql } from "drizzle-orm";
import type { WebSocket } from "../util/WebSocket";
import { Send, SessionRuntime } from "../util";

const PUBLIC_USER_EVENTS = new Set([
  "PresenceUpdate",
  "UserUpdate",
  "CustomStatusScheduleUpdate",
]);

async function canSubscribeToUser(viewerId: string, targetId: string) {
  if (viewerId === targetId) return true;

  const friend = await db.query.relationshipsTable.findFirst({
    columns: { id: true },
    where: and(
      eq(relationshipsTable.userId, BigInt(viewerId)),
      eq(relationshipsTable.otherUserId, BigInt(targetId)),
      eq(relationshipsTable.type, RelationshipType.Friend),
    ),
  });
  if (friend) return true;

  const sharedSpace = await db
    .select({ spaceId: spaceMembersTable.spaceId })
    .from(spaceMembersTable)
    .where(
      and(
        eq(spaceMembersTable.userId, BigInt(viewerId)),
        sql`exists (
          select 1 from ${spaceMembersTable} sm2
          where sm2."spaceId" = ${spaceMembersTable.spaceId}
          and sm2."userId" = ${BigInt(targetId)}
        )`,
      ),
    )
    .limit(1);
  if (sharedSpace.length > 0) return true;

  const sharedDm = await db
    .select({ channelId: channelRecipientsTable.channelId })
    .from(channelRecipientsTable)
    .where(
      and(
        eq(channelRecipientsTable.userId, BigInt(viewerId)),
        eq(channelRecipientsTable.closed, false),
        sql`exists (
          select 1 from ${channelRecipientsTable} cr2
          where cr2."channelId" = ${channelRecipientsTable.channelId}
          and cr2."userId" = ${BigInt(targetId)}
          and cr2.closed = false
        )`,
      ),
    )
    .limit(1);

  return sharedDm.length > 0;
}

function consumePublicUserEvents(this: WebSocket, opts: EventOpts) {
  const { event, data } = opts;
  if (!PUBLIC_USER_EVENTS.has(String(event))) {
    opts?.acknowledge?.();
    return;
  }

  void Send(this, {
    op: "Dispatch",
    s: SessionRuntime.nextSequence(this.sessionId, this),
    t: event as any,
    d: data,
  }).finally(() => opts?.acknowledge?.());
}

export async function onSubscribeUser(this: WebSocket, { d }: GatewayPayload) {
  if (!this.userId) return;

  const userId = String(d?.userId ?? "");
  if (!userId) return;

  this.userSubscriptions = this.userSubscriptions ?? {};

  if (this.events[userId]) return;
  if (this.userSubscriptions[userId]) return;
  if (!this.listenOptions.channel) return;

  if (!(await canSubscribeToUser(this.userId, userId))) return;

  this.userSubscriptions[userId] = await listenEvent(
    userId,
    consumePublicUserEvents.bind(this),
    this.listenOptions,
  );
}

export async function onUnsubscribeUser(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const userId = String(d?.userId ?? "");
  if (!userId) return;

  this.userSubscriptions?.[userId]?.();
  delete this.userSubscriptions?.[userId];
}

export const subscribeUserOpcode = GatewayOpcodes.SubscribeUser;
export const unsubscribeUserOpcode = GatewayOpcodes.UnsubscribeUser;
