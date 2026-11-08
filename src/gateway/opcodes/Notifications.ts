import { db, notificationsTable } from "@mutualzz/database";
import type { GatewayPayload } from "@mutualzz/types";
import { emitEvent } from "@mutualzz/util";
import {
  markNotificationsRead,
  serializeNotification,
} from "@mutualzz/util/notifications";
import {
  gatewayNoncePayload,
  gatewayNotificationDeletePayload,
  gatewayNotificationListPayload,
  gatewayNotificationMarkReadPayload,
  NOTIFICATION_PAGE_SIZE,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "NotificationAck",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...result },
  });

const ackInvalid = async (socket: WebSocket, data: unknown) => {
  const parsed = gatewayNoncePayload.safeParse(data);
  if (parsed.success)
    await ack(socket, parsed.data.nonce, {
      ok: false,
      message: "Invalid request",
    });
};

export async function onNotificationList(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNotificationListPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, before } = parsed.data;

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, BigInt(userId)),
        before ? lt(notificationsTable.id, BigInt(before)) : undefined,
      ),
    )
    .orderBy(desc(notificationsTable.id))
    .limit(NOTIFICATION_PAGE_SIZE + 1);

  await ack(this, nonce, {
    ok: true,
    notifications: rows
      .slice(0, NOTIFICATION_PAGE_SIZE)
      .map(serializeNotification),
    hasMore: rows.length > NOTIFICATION_PAGE_SIZE,
  });
}

export async function onNotificationMarkRead(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNotificationMarkReadPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);

  const marked = await markNotificationsRead(
    userId,
    "all" in parsed.data ? "all" : parsed.data.ids,
  );

  await ack(this, parsed.data.nonce, { ok: true, marked });
}

export async function onNotificationDelete(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNotificationDeletePayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, id } = parsed.data;

  const [removed] = await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.id, BigInt(id)),
        eq(notificationsTable.userId, BigInt(userId)),
      ),
    )
    .returning({ id: notificationsTable.id });

  if (removed)
    await emitEvent({
      event: "NotificationDelete",
      user_id: userId,
      data: { id },
    });

  await ack(this, nonce, { ok: true });
}
