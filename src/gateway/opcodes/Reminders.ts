import { db, messageRemindersTable } from "@mutualzz/database";
import type { GatewayPayload } from "@mutualzz/types";
import { emitEvent } from "@mutualzz/util";
import { serializeReminder } from "@mutualzz/util/Reminders";
import {
  gatewayNoncePayload,
  gatewayReminderDeletePayload,
  gatewayReminderSetPayload,
  MAX_REMINDERS,
} from "@mutualzz/validators";
import { and, asc, count, eq } from "drizzle-orm";
import {
  filterReadable,
  findReadableMessage,
  loadHydratedMessages,
} from "../util/MessageAccess";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "MessageReminderAck",
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

const ownReminder = (userId: string, messageId: bigint) =>
  and(
    eq(messageRemindersTable.userId, BigInt(userId)),
    eq(messageRemindersTable.messageId, messageId),
  );

export async function onReminderSet(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayReminderSetPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, messageId, remindAt } = parsed.data;

  const message = await findReadableMessage(userId, messageId);
  if (!message)
    return ack(this, nonce, { ok: false, message: "Message not found" });

  const existing = await db.query.messageRemindersTable.findFirst({
    columns: { messageId: true },
    where: ownReminder(userId, message.id),
  });

  if (!existing) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(messageRemindersTable)
      .where(eq(messageRemindersTable.userId, BigInt(userId)));

    if (total >= MAX_REMINDERS)
      return ack(this, nonce, { ok: false, message: "Reminder limit reached" });
  }

  const remindAtDate = new Date(remindAt);

  const [row] = await db
    .insert(messageRemindersTable)
    .values({
      userId: BigInt(userId),
      messageId: message.id,
      channelId: message.channelId,
      remindAt: remindAtDate,
    })
    .onConflictDoUpdate({
      target: [messageRemindersTable.userId, messageRemindersTable.messageId],
      set: { remindAt: remindAtDate, firedAt: null },
    })
    .returning();

  const reminder = serializeReminder(row);

  await emitEvent({
    event: "MessageReminderUpdate",
    user_id: userId,
    data: reminder,
  });
  await ack(this, nonce, { ok: true, reminder });
}

export async function onReminderDelete(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayReminderDeletePayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, messageId } = parsed.data;

  const [removed] = await db
    .delete(messageRemindersTable)
    .where(ownReminder(userId, BigInt(messageId)))
    .returning({ messageId: messageRemindersTable.messageId });

  if (removed)
    await emitEvent({
      event: "MessageReminderDelete",
      user_id: userId,
      data: { messageId },
    });

  await ack(this, nonce, { ok: true });
}

export async function onReminderList(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNoncePayload.safeParse(d);
  if (!parsed.success) return;
  const { nonce } = parsed.data;

  const rows = await db.query.messageRemindersTable.findMany({
    where: eq(messageRemindersTable.userId, BigInt(userId)),
    orderBy: asc(messageRemindersTable.remindAt),
    limit: MAX_REMINDERS,
  });

  const visibleRows = await filterReadable(userId, rows);
  const messagesById = await loadHydratedMessages(
    userId,
    visibleRows.map((row) => row.messageId),
  );

  const reminders = visibleRows.flatMap((row) => {
    const message = messagesById.get(row.messageId.toString());
    return message ? [{ ...serializeReminder(row), message }] : [];
  });

  await ack(this, nonce, { ok: true, reminders });
}
