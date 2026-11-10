import {
  db,
  mentionDismissalsTable,
  messagesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  userSettingsTable,
} from "@mutualzz/database";
import type { GatewayPayload } from "@mutualzz/types";
import { emitEvent, Snowflake } from "@mutualzz/util";
import {
  gatewayMentionDismissPayload,
  gatewayMentionListPayload,
  gatewayNoncePayload,
  MENTIONS_PAGE_SIZE,
} from "@mutualzz/validators";
import {
  and,
  desc,
  eq,
  gt,
  lte,
  inArray,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { filterReadable, loadHydratedMessages } from "../util/MessageAccess";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "MentionAck",
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

const mentionsContain = (mention: { type: string; id?: string }) =>
  sql`${messagesTable.mentions} @> ${JSON.stringify([mention])}::jsonb`;

export async function onMentionList(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayMentionListPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, before, includeEveryone, includeRoles, spaceId } = parsed.data;

  const settings = await db.query.userSettingsTable.findFirst({
    columns: { mentionsClearedBefore: true },
    where: eq(userSettingsTable.userId, BigInt(userId)),
  });
  const clearedBefore = settings?.mentionsClearedBefore ?? null;

  const memberships = await db
    .select({ spaceId: spaceMembersTable.spaceId })
    .from(spaceMembersTable)
    .where(eq(spaceMembersTable.userId, BigInt(userId)));
  const spaceIds = memberships.map((membership) => membership.spaceId);

  const roleRows = includeRoles
    ? await db
        .select({ roleId: spaceMemberRolesTable.roleId })
        .from(spaceMemberRolesTable)
        .where(eq(spaceMemberRolesTable.userId, BigInt(userId)))
    : [];

  const mentionConditions: SQL[] = [
    mentionsContain({ type: "user", id: userId }),
    ...roleRows.map((row) =>
      mentionsContain({ type: "role", id: row.roleId.toString() }),
    ),
  ];

  if (includeEveryone && spaceIds.length > 0)
    mentionConditions.push(
      and(
        mentionsContain({ type: "everyone" }),
        inArray(messagesTable.spaceId, spaceIds),
      )!,
    );

  const candidates = await db
    .select({ id: messagesTable.id, channelId: messagesTable.channelId })
    .from(messagesTable)
    .where(
      and(
        or(...mentionConditions),
        ne(messagesTable.authorId, BigInt(userId)),
        spaceId ? eq(messagesTable.spaceId, BigInt(spaceId)) : undefined,
        before ? lt(messagesTable.id, BigInt(before)) : undefined,
        clearedBefore ? gt(messagesTable.id, clearedBefore) : undefined,
        notExists(
          db
            .select({ messageId: mentionDismissalsTable.messageId })
            .from(mentionDismissalsTable)
            .where(
              and(
                eq(mentionDismissalsTable.userId, BigInt(userId)),
                eq(mentionDismissalsTable.messageId, messagesTable.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(messagesTable.id))
    .limit(MENTIONS_PAGE_SIZE + 1);

  const page = candidates.slice(0, MENTIONS_PAGE_SIZE);
  const visible = await filterReadable(userId, page);
  const messagesById = await loadHydratedMessages(
    userId,
    visible.map((row) => row.id),
  );

  await ack(this, nonce, {
    ok: true,
    messages: visible.flatMap((row) => {
      const message = messagesById.get(row.id.toString());
      return message ? [message] : [];
    }),
    hasMore: candidates.length > MENTIONS_PAGE_SIZE,
    nextBefore: page.at(-1)?.id.toString() ?? null,
  });
}

export async function onMentionDismiss(this: WebSocket, { d }: GatewayPayload) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayMentionDismissPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, messageId } = parsed.data;

  const message = await db.query.messagesTable.findFirst({
    columns: { id: true },
    where: eq(messagesTable.id, BigInt(messageId)),
  });
  if (!message)
    return ack(this, nonce, { ok: false, message: "Message not found" });

  await db
    .insert(mentionDismissalsTable)
    .values({ userId: BigInt(userId), messageId: message.id })
    .onConflictDoNothing();

  await emitEvent({
    event: "MentionDismiss",
    user_id: userId,
    data: { messageId },
  });
  await ack(this, nonce, { ok: true });
}

export async function onMentionClearAll(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayNoncePayload.safeParse(d);
  if (!parsed.success) return;
  const { nonce } = parsed.data;

  const clearedBefore = BigInt(Snowflake.generate());

  await db
    .insert(userSettingsTable)
    .values({ userId: BigInt(userId), mentionsClearedBefore: clearedBefore })
    .onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: { mentionsClearedBefore: clearedBefore },
    });

  await db
    .delete(mentionDismissalsTable)
    .where(
      and(
        eq(mentionDismissalsTable.userId, BigInt(userId)),
        lte(mentionDismissalsTable.messageId, clearedBefore),
      ),
    );

  await emitEvent({
    event: "MentionsCleared",
    user_id: userId,
    data: { before: clearedBefore.toString() },
  });
  await ack(this, nonce, { ok: true });
}
