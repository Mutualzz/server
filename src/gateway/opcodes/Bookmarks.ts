import { db, messageBookmarksTable } from "@mutualzz/database";
import type { GatewayPayload } from "@mutualzz/types";
import { emitEvent } from "@mutualzz/util";
import {
  gatewayBookmarkPayload,
  gatewayNoncePayload,
  MAX_BOOKMARKS,
} from "@mutualzz/validators";
import { and, count, desc, eq } from "drizzle-orm";
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
    t: "MessageBookmarkAck",
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

export async function onBookmarkAdd(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayBookmarkPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, messageId } = parsed.data;

  const message = await findReadableMessage(userId, messageId);
  if (!message)
    return ack(this, nonce, { ok: false, message: "Message not found" });

  const existing = await db.query.messageBookmarksTable.findFirst({
    columns: { messageId: true },
    where: and(
      eq(messageBookmarksTable.userId, BigInt(userId)),
      eq(messageBookmarksTable.messageId, message.id),
    ),
  });
  if (existing) return ack(this, nonce, { ok: true, bookmark: null });

  const [{ total }] = await db
    .select({ total: count() })
    .from(messageBookmarksTable)
    .where(eq(messageBookmarksTable.userId, BigInt(userId)));

  if (total >= MAX_BOOKMARKS)
    return ack(this, nonce, { ok: false, message: "Bookmark limit reached" });

  const [inserted] = await db
    .insert(messageBookmarksTable)
    .values({
      userId: BigInt(userId),
      messageId: message.id,
      channelId: message.channelId,
    })
    .onConflictDoNothing()
    .returning();

  const bookmark = inserted && {
    messageId: inserted.messageId.toString(),
    channelId: inserted.channelId.toString(),
    createdAt: inserted.createdAt.toISOString(),
  };

  if (bookmark)
    await emitEvent({
      event: "MessageBookmarkCreate",
      user_id: userId,
      data: bookmark,
    });

  await ack(this, nonce, { ok: true, bookmark: bookmark ?? null });
}

export async function onBookmarkRemove(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayBookmarkPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, messageId } = parsed.data;

  const [removed] = await db
    .delete(messageBookmarksTable)
    .where(
      and(
        eq(messageBookmarksTable.userId, BigInt(userId)),
        eq(messageBookmarksTable.messageId, BigInt(messageId)),
      ),
    )
    .returning({ messageId: messageBookmarksTable.messageId });

  if (removed)
    await emitEvent({
      event: "MessageBookmarkDelete",
      user_id: userId,
      data: { messageId },
    });

  await ack(this, nonce, { ok: true });
}

export async function onBookmarkList(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNoncePayload.safeParse(d);
  if (!parsed.success) return;
  const { nonce } = parsed.data;

  const rows = await db.query.messageBookmarksTable.findMany({
    where: eq(messageBookmarksTable.userId, BigInt(userId)),
    orderBy: desc(messageBookmarksTable.createdAt),
    limit: MAX_BOOKMARKS,
  });

  const visibleRows = await filterReadable(userId, rows);
  const messagesById = await loadHydratedMessages(
    userId,
    visibleRows.map((row) => row.messageId),
  );

  const bookmarks = visibleRows.flatMap((row) => {
    const message = messagesById.get(row.messageId.toString());
    if (!message) return [];
    return [
      {
        messageId: row.messageId.toString(),
        channelId: row.channelId.toString(),
        createdAt: row.createdAt.toISOString(),
        message,
      },
    ];
  });

  await ack(this, nonce, { ok: true, bookmarks });
}
