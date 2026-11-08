import { db, scheduledMessagesTable } from "@mutualzz/database";
import type { GatewayPayload } from "@mutualzz/types";
import {
  deleteScheduledAttachments,
  emitScheduledMessageDelete,
  emitScheduledMessageUpdate,
  serializeScheduledMessage,
} from "@mutualzz/util/messages/scheduledMessages";
import {
  gatewayNoncePayload,
  gatewayScheduledMessageDeletePayload,
  gatewayScheduledMessageEditPayload,
} from "@mutualzz/validators";
import { and, eq, ne } from "drizzle-orm";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "ScheduledMessageAck",
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

const ownScheduledMessage = (userId: string, id: string) =>
  and(
    eq(scheduledMessagesTable.id, BigInt(id)),
    eq(scheduledMessagesTable.authorId, BigInt(userId)),
  );

export async function onScheduledMessageEdit(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayScheduledMessageEditPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, id, content, scheduledFor } = parsed.data;

  const row = await db.query.scheduledMessagesTable.findFirst({
    where: ownScheduledMessage(userId, id),
  });

  if (!row)
    return ack(this, nonce, {
      ok: false,
      message: "Scheduled message not found",
    });

  const nextContent = content === undefined ? row.content : content || null;
  const isEmpty =
    !nextContent &&
    row.expressionIds.length === 0 &&
    row.attachments.length === 0 &&
    !row.sharedPostId &&
    row.codedLinks.length === 0;

  if (isEmpty)
    return ack(this, nonce, {
      ok: false,
      message: "Message must have content, stickers, or attachments",
    });

  const [updated] = await db
    .update(scheduledMessagesTable)
    .set({
      content: nextContent,
      ...(scheduledFor ? { scheduledFor: new Date(scheduledFor) } : {}),
      status: "pending",
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        ownScheduledMessage(userId, id),
        ne(scheduledMessagesTable.status, "sending"),
      ),
    )
    .returning();

  if (!updated)
    return ack(this, nonce, {
      ok: false,
      message: "This message is being sent right now",
    });

  await emitScheduledMessageUpdate(updated);
  await ack(this, nonce, {
    ok: true,
    scheduledMessage: serializeScheduledMessage(updated),
  });
}

export async function onScheduledMessageDelete(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayScheduledMessageDeletePayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, id } = parsed.data;

  const [removed] = await db
    .delete(scheduledMessagesTable)
    .where(
      and(
        ownScheduledMessage(userId, id),
        ne(scheduledMessagesTable.status, "sending"),
      ),
    )
    .returning();

  if (!removed)
    return ack(this, nonce, {
      ok: false,
      message: "Scheduled message not found or being sent right now",
    });

  void deleteScheduledAttachments(removed.attachments);
  await emitScheduledMessageDelete(removed, null);
  await ack(this, nonce, { ok: true });
}
