import { db, messagesTable } from "@mutualzz/database";
import { ChannelType, type APIMessage } from "@mutualzz/types";
import { execNormalizedMany, hydrateMessagesForResponse } from "@mutualzz/util";
import {
  getChannel,
  isChannelRecipient,
  publicUserColumns,
} from "@mutualzz/util/Helpers";
import { requireChannelPermissions } from "@mutualzz/util/permissions/channel";
import { eq, inArray } from "drizzle-orm";

export const canReadChannel = async (userId: string, channelId: string) => {
  const channel = await getChannel(channelId);
  if (!channel) return false;

  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM)
    return isChannelRecipient(channel.id, userId);

  try {
    await requireChannelPermissions({
      channelId: channel.id,
      userId,
      needed: ["ViewChannel", "ReadMessageHistory"],
    });
    return true;
  } catch {
    return false;
  }
};

export const findReadableMessage = async (
  userId: string,
  messageId: string,
) => {
  const message = await db.query.messagesTable.findFirst({
    columns: { id: true, channelId: true },
    where: eq(messagesTable.id, BigInt(messageId)),
  });
  if (!message) return null;

  return (await canReadChannel(userId, message.channelId.toString()))
    ? message
    : null;
};

export const filterReadable = async <Row extends { channelId: bigint }>(
  userId: string,
  rows: Row[],
) => {
  const channelIds = [...new Set(rows.map((row) => row.channelId.toString()))];
  const readable = await Promise.all(
    channelIds.map((channelId) => canReadChannel(userId, channelId)),
  );
  const readableChannelIds = new Set(
    channelIds.filter((_channelId, index) => readable[index]),
  );
  return rows.filter((row) => readableChannelIds.has(row.channelId.toString()));
};

export const loadHydratedMessages = async (
  userId: string,
  messageIds: bigint[],
) => {
  if (messageIds.length === 0) return new Map<string, APIMessage>();

  const messages = await execNormalizedMany<APIMessage>(
    db.query.messagesTable.findMany({
      where: inArray(messagesTable.id, messageIds),
      with: { author: { columns: publicUserColumns } },
    }),
  );
  const hydrated = await hydrateMessagesForResponse(messages, userId);
  return new Map(hydrated.map((message) => [message.id.toString(), message]));
};
