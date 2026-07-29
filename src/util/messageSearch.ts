import { messagesTable } from "@mutualzz/database";
import type { APIChannel } from "@mutualzz/types";
import {
  isMessageSearchQueryReady,
  parseMessageSearchQuery,
  type MessageSearchHasFilter,
} from "@mutualzz/validators";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import {
  and,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { isSnowflakeIdentifier, resolveUserIdentifier } from "./Helpers";

dayjs.extend(customParseFormat);

function parseSearchDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isSnowflakeIdentifier(trimmed)) {
    const timestamp = Number((BigInt(trimmed) >> 22n) + 1420070400000n);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp);
    }
  }

  const formats = ["YYYY-MM-DD", "YYYY/MM/DD", "M/D/YYYY", "MM/DD/YYYY"];
  for (const format of formats) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed.endOf("day").toDate();
    }
  }

  const loose = dayjs(trimmed);
  return loose.isValid() ? loose.toDate() : null;
}

function parseSearchDateStart(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isSnowflakeIdentifier(trimmed)) {
    const timestamp = Number((BigInt(trimmed) >> 22n) + 1420070400000n);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp);
    }
  }

  const formats = ["YYYY-MM-DD", "YYYY/MM/DD", "M/D/YYYY", "MM/DD/YYYY"];
  for (const format of formats) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed.startOf("day").toDate();
    }
  }

  const loose = dayjs(trimmed);
  return loose.isValid() ? loose.toDate() : null;
}

function hasFilterCondition(filter: MessageSearchHasFilter): SQL {
  switch (filter) {
    case "link":
      return or(
        sql`jsonb_array_length(${messagesTable.codedLinks}) > 0`,
        sql`${messagesTable.content} ~* 'https?://'`,
      )!;
    case "embed":
      return sql`jsonb_array_length(${messagesTable.embeds}) > 0`;
    case "file":
      return sql`jsonb_array_length(${messagesTable.attachments}) > 0`;
    case "image":
      return sql`exists (
        select 1 from jsonb_array_elements(${messagesTable.attachments}) elem
        where elem->>'contentType' like 'image/%'
      )`;
    case "video":
      return sql`exists (
        select 1 from jsonb_array_elements(${messagesTable.attachments}) elem
        where elem->>'contentType' like 'video/%'
      )`;
    case "sticker":
      return sql`cardinality(${messagesTable.expressionIds}) > 0`;
  }
}

function mentionsUserCondition(userId: bigint): SQL {
  return sql`exists (
    select 1 from jsonb_array_elements(${messagesTable.mentions}) elem
    where elem->>'id' = ${userId.toString()} and elem->>'type' = 'user'
  )`;
}

function resolveChannelByName(
  name: string,
  channels: APIChannel[],
): bigint | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  const exact = channels.find(
    (channel) => channel.name?.trim().toLowerCase() === normalized,
  );
  if (exact) return BigInt(exact.id);

  const partial = channels.find((channel) =>
    channel.name?.trim().toLowerCase().includes(normalized),
  );
  return partial ? BigInt(partial.id) : null;
}

async function resolveSearchUserId(
  value: string,
  currentUserId: string,
): Promise<bigint | null> {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "me") return BigInt(currentUserId);

  const user = await resolveUserIdentifier(value);
  return user ? BigInt(user.id) : null;
}

export async function buildMessageSearchWhere(
  rawQuery: string,
  options: {
    currentUserId: string;
    channelId?: bigint;
    channelIds?: bigint[];
    visibleChannels?: APIChannel[];
    allowChannelFilter?: boolean;
  },
): Promise<SQL[]> {
  if (!isMessageSearchQueryReady(rawQuery)) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Search query is too short",
    );
  }

  const parsed = parseMessageSearchQuery(rawQuery);
  const conditions: SQL[] = [];

  if (options.channelId) {
    conditions.push(eq(messagesTable.channelId, options.channelId));
  } else if (options.channelIds?.length) {
    conditions.push(inArray(messagesTable.channelId, options.channelIds));
  }

  if (parsed.text.trim()) {
    conditions.push(ilike(messagesTable.content, `%${parsed.text.trim()}%`));
  }

  if (parsed.from) {
    const authorId = await resolveSearchUserId(parsed.from, options.currentUserId);
    if (!authorId) {
      throw new HttpException(HttpStatusCode.BadRequest, "Unknown user in from:");
    }
    conditions.push(eq(messagesTable.authorId, authorId));
  }

  if (parsed.mentions) {
    const mentionUserId = await resolveSearchUserId(
      parsed.mentions,
      options.currentUserId,
    );
    if (!mentionUserId) {
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "Unknown user in mentions:",
      );
    }
    conditions.push(mentionsUserCondition(mentionUserId));
  }

  if (parsed.in) {
    if (!options.allowChannelFilter || !options.visibleChannels?.length) {
      throw new HttpException(
        HttpStatusCode.BadRequest,
        "Channel filter is not available here",
      );
    }

    const channelId = resolveChannelByName(parsed.in, options.visibleChannels);
    if (!channelId) {
      throw new HttpException(HttpStatusCode.BadRequest, "Unknown channel in in:");
    }
    conditions.push(eq(messagesTable.channelId, channelId));
  }

  if (parsed.pinned) {
    conditions.push(eq(messagesTable.pinned, true));
  }

  if (parsed.before) {
    const before = parseSearchDate(parsed.before);
    if (!before) {
      throw new HttpException(HttpStatusCode.BadRequest, "Invalid before: date");
    }
    conditions.push(lte(messagesTable.createdAt, before));
  }

  if (parsed.after) {
    const after = parseSearchDateStart(parsed.after);
    if (!after) {
      throw new HttpException(HttpStatusCode.BadRequest, "Invalid after: date");
    }
    conditions.push(gte(messagesTable.createdAt, after));
  }

  for (const filter of parsed.has) {
    conditions.push(hasFilterCondition(filter));
  }

  return conditions;
}

export function combineMessageSearchWhere(conditions: SQL[]): SQL | undefined {
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}
