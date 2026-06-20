import { messageReactionsTable } from "@mutualzz/database";
import { db } from "@mutualzz/database";
import {
  type APIChannel,
  type APIExpression,
  type APIMessage,
  type APIMessageReaction,
  type APIMessageReactionEmoji,
  ExpressionType,
  HttpException,
  HttpStatusCode,
  type Snowflake,
} from "@mutualzz/types";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import emojiRegex from "emojibase-regex";
import { getExpression, publicUserColumns, resolveExpressions } from "./Helpers";
import type { z } from "zod";
import type { validateReactionEmojiBody } from "@mutualzz/validators";

const isValidUnicodeEmoji = (value: string) => {
  const match = value.match(emojiRegex);
  return match !== null && match[0] === value;
};

export const MAX_REACTIONS_PER_MESSAGE = 20;

export type ReactionEmojiInput = z.infer<
  typeof validateReactionEmojiBody
>["emoji"];

export const reactionEmojiKey = (
  unicode: string | null | undefined,
  expressionId: bigint | null | undefined,
) => {
  if (expressionId != null) return `e:${expressionId.toString()}`;
  return `u:${unicode ?? ""}`;
};

export const reactionEmojisMatch = (
  a: APIMessageReactionEmoji,
  b: APIMessageReactionEmoji,
) => {
  if (a.type === "unicode" && b.type === "unicode") return a.value === b.value;
  if (a.type === "expression" && b.type === "expression") {
    return a.expression.id === b.expression.id;
  }
  return false;
};

export const parseReactionEmojiInput = (
  emoji: ReactionEmojiInput,
): { unicode: string | null; expressionId: bigint | null } => {
  if (emoji.type === "unicode") {
    if (!isValidUnicodeEmoji(emoji.value)) {
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "Invalid unicode emoji",
      );
    }

    return { unicode: emoji.value, expressionId: null };
  }

  return { unicode: null, expressionId: BigInt(emoji.id) };
};

export const toReactionEmoji = async (
  unicode: string | null,
  expressionId: bigint | null,
  expressionCache = new Map<string, APIExpression>(),
): Promise<APIMessageReactionEmoji | null> => {
  if (expressionId != null) {
    const id = expressionId.toString();
    let expression = expressionCache.get(id);
    if (!expression) {
      expression = (await getExpression(id)) ?? undefined;
      if (expression) expressionCache.set(id, expression);
    }
    if (!expression) return null;

    return { type: "expression", expression };
  }

  if (unicode) return { type: "unicode", value: unicode };

  return null;
};

export const validateReactionExpression = async ({
  expressionId,
  channel,
  userId,
  canUseExternalEmojis,
}: {
  expressionId: string;
  channel: APIChannel;
  userId: string;
  canUseExternalEmojis: boolean;
}): Promise<APIExpression> => {
  const expression = await getExpression(expressionId);

  if (!expression) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Emoji could not be found",
    );
  }

  if (expression.type !== ExpressionType.Emoji) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Only emojis can be used as reactions",
    );
  }

  let allowed = false;

  if (!expression.spaceId && expression.authorId === userId) {
    allowed = true;
  } else if (
    channel.spaceId &&
    expression.spaceId &&
    expression.spaceId === channel.spaceId
  ) {
    allowed = true;
  } else if (canUseExternalEmojis) {
    allowed = true;
  } else if (!channel.spaceId) {
    allowed = !expression.spaceId && expression.authorId === userId;
  }

  if (!allowed) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      `You cannot use the emoji :${expression.name}:`,
    );
  }

  return expression;
};

export async function aggregateReactions(
  messageIds: bigint[],
  viewerUserId: string,
): Promise<Record<string, APIMessageReaction[]>> {
  if (!messageIds.length) return {};

  const rows = await db
    .select({
      messageId: messageReactionsTable.messageId,
      userId: messageReactionsTable.userId,
      unicode: messageReactionsTable.unicode,
      expressionId: messageReactionsTable.expressionId,
    })
    .from(messageReactionsTable)
    .where(inArray(messageReactionsTable.messageId, messageIds));

  const expressionCache = new Map<string, APIExpression>();
  const grouped = new Map<
    string,
    Map<
      string,
      {
        count: number;
        me: boolean;
        unicode: string | null;
        expressionId: bigint | null;
      }
    >
  >();

  for (const row of rows) {
    const messageId = row.messageId.toString();
    const key = reactionEmojiKey(row.unicode, row.expressionId);

    if (!grouped.has(messageId)) grouped.set(messageId, new Map());

    const messageGroup = grouped.get(messageId)!;
    const existing = messageGroup.get(key);

    if (existing) {
      existing.count += 1;
      if (row.userId.toString() === viewerUserId) existing.me = true;
    } else {
      messageGroup.set(key, {
        count: 1,
        me: row.userId.toString() === viewerUserId,
        unicode: row.unicode,
        expressionId: row.expressionId,
      });
    }
  }

  const result: Record<string, APIMessageReaction[]> = {};

  for (const [messageId, emojiMap] of grouped) {
    const reactions: APIMessageReaction[] = [];

    for (const entry of emojiMap.values()) {
      const emoji = await toReactionEmoji(
        entry.unicode,
        entry.expressionId,
        expressionCache,
      );
      if (!emoji) continue;

      reactions.push({
        emoji,
        count: entry.count,
        me: entry.me,
      });
    }

    result[messageId] = reactions;
  }

  return result;
}

export async function attachReactionsToMessages<T extends APIMessage>(
  messages: T[],
  viewerUserId: string,
): Promise<T[]> {
  if (!messages.length) return messages;

  const reactionMap = await aggregateReactions(
    messages.map((message) => BigInt(message.id)),
    viewerUserId,
  );

  return messages.map((message) => ({
    ...message,
    reactions: reactionMap[message.id] ?? [],
  }));
}

export async function hydrateMessagesForResponse<T extends APIMessage>(
  messages: T[],
  viewerUserId: string,
  resolveExpressionContent = true,
): Promise<T[]> {
  const withExpressions = resolveExpressionContent
    ? await Promise.all(
        messages.map(async (message) => ({
          ...message,
          expressions: await resolveExpressions(
            message.content ?? "",
            message.expressionIds,
          ),
          expressionIds: (message.expressionIds ?? []).map((id) => id.toString()),
        })),
      )
    : messages;

  return attachReactionsToMessages(withExpressions, viewerUserId);
}

export const buildReactionEmojiPayload = async (
  unicode: string | null,
  expressionId: bigint | null,
): Promise<APIMessageReactionEmoji> => {
  const emoji = await toReactionEmoji(unicode, expressionId);
  if (!emoji) {
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "Failed to resolve reaction emoji",
    );
  }

  return emoji;
};

export const countDistinctReactionEmojis = async (messageId: bigint) => {
  const [row] = await db
    .select({
      count: sql<number>`count(distinct coalesce(${messageReactionsTable.expressionId}::text, ${messageReactionsTable.unicode}))`,
    })
    .from(messageReactionsTable)
    .where(eq(messageReactionsTable.messageId, messageId));

  return Number(row?.count ?? 0);
};

export const reactionExistsForUser = async ({
  messageId,
  userId,
  unicode,
  expressionId,
}: {
  messageId: bigint;
  userId: bigint;
  unicode: string | null;
  expressionId: bigint | null;
}) => {
  const where = expressionId
    ? and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.userId, userId),
        eq(messageReactionsTable.expressionId, expressionId),
      )
    : and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.userId, userId),
        eq(messageReactionsTable.unicode, unicode!),
        isNull(messageReactionsTable.expressionId),
      );

  const row = await db.query.messageReactionsTable.findFirst({
    columns: { id: true },
    where,
  });

  return !!row;
};

export const emojiUsedOnMessage = async ({
  messageId,
  unicode,
  expressionId,
}: {
  messageId: bigint;
  unicode: string | null;
  expressionId: bigint | null;
}) => {
  const where = expressionId
    ? and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.expressionId, expressionId),
      )
    : and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.unicode, unicode!),
        isNull(messageReactionsTable.expressionId),
      );

  const row = await db.query.messageReactionsTable.findFirst({
    columns: { id: true },
    where,
  });

  return !!row;
};

export const getReactionUsers = async ({
  messageId,
  unicode,
  expressionId,
  after,
  limit,
}: {
  messageId: bigint;
  unicode: string | null;
  expressionId: bigint | null;
  after?: Snowflake;
  limit: number;
}) => {
  const emojiWhere = expressionId
    ? eq(messageReactionsTable.expressionId, expressionId)
    : and(
        eq(messageReactionsTable.unicode, unicode!),
        isNull(messageReactionsTable.expressionId),
      );

  const where = after
    ? and(
        eq(messageReactionsTable.messageId, messageId),
        emojiWhere,
        gt(messageReactionsTable.userId, BigInt(after)),
      )
    : and(eq(messageReactionsTable.messageId, messageId), emojiWhere);

  return db.query.messageReactionsTable.findMany({
    where,
    with: {
      user: {
        columns: publicUserColumns,
      },
    },
    orderBy: asc(messageReactionsTable.userId),
    limit,
  });
};

export const deleteReactionsForEmoji = async ({
  messageId,
  unicode,
  expressionId,
}: {
  messageId: bigint;
  unicode: string | null;
  expressionId: bigint | null;
}) => {
  const where = expressionId
    ? and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.expressionId, expressionId),
      )
    : and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.unicode, unicode!),
        isNull(messageReactionsTable.expressionId),
      );

  await db.delete(messageReactionsTable).where(where);
};

export const deleteAllReactions = async (messageId: bigint) => {
  await db
    .delete(messageReactionsTable)
    .where(eq(messageReactionsTable.messageId, messageId));
};

export const deleteUserReaction = async ({
  messageId,
  userId,
  unicode,
  expressionId,
}: {
  messageId: bigint;
  userId: bigint;
  unicode: string | null;
  expressionId: bigint | null;
}) => {
  const where = expressionId
    ? and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.userId, userId),
        eq(messageReactionsTable.expressionId, expressionId),
      )
    : and(
        eq(messageReactionsTable.messageId, messageId),
        eq(messageReactionsTable.userId, userId),
        eq(messageReactionsTable.unicode, unicode!),
        isNull(messageReactionsTable.expressionId),
      );

  const result = await db.delete(messageReactionsTable).where(where).returning({
    id: messageReactionsTable.id,
  });

  return result.length > 0;
};

export const parseReactionUsersQueryEmoji = (query: {
  type: "unicode" | "expression";
  value?: string;
  id?: string;
}) => {
  if (query.type === "unicode") {
    if (!query.value) {
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "Unicode emoji value is required",
      );
    }

    return parseReactionEmojiInput({
      type: "unicode",
      value: query.value,
    });
  }

  if (!query.id) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Expression id is required",
    );
  }

  return parseReactionEmojiInput({
    type: "expression",
    id: query.id,
  });
};

export const reactionWhereForEmoji = (
  messageId: bigint,
  unicode: string | null,
  expressionId: bigint | null,
) => {
  if (expressionId != null) {
    return and(
      eq(messageReactionsTable.messageId, messageId),
      eq(messageReactionsTable.expressionId, expressionId),
    );
  }

  return and(
    eq(messageReactionsTable.messageId, messageId),
    eq(messageReactionsTable.unicode, unicode!),
    isNull(messageReactionsTable.expressionId),
  );
};

export const hasAnyReactionForEmoji = async (
  messageId: bigint,
  unicode: string | null,
  expressionId: bigint | null,
) => {
  const row = await db.query.messageReactionsTable.findFirst({
    columns: { id: true },
    where: reactionWhereForEmoji(messageId, unicode, expressionId),
  });

  return !!row;
};
