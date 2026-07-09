import {
  channelRecipientsTable,
  db,
  pushTokensTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  userSettingsTable,
} from "@mutualzz/database";
import { PresenceService } from "@mutualzz/gateway/presence/Presence.service";
import { unavailableLike } from "@mutualzz/gateway/util/Calculations";
import { Logger } from "@mutualzz/logger";
import { type APIMessage, ChannelType } from "@mutualzz/types";
import { and, eq, sql } from "drizzle-orm";
import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from "expo-server-sdk";

import {
  buildAuthorAvatarUrl,
  type PushAuthorAvatar,
} from "./pushNotificationAvatar.js";
import { formatPushNotificationBody } from "./pushNotificationContent.js";

const ANDROID_MESSAGE_CHANNEL_ID = "messages";
const MESSAGE_PUSH_DISPLAY_MODE = "notifee";

const logger = new Logger({ tag: "PushNotifications" });

const expoAccessToken = process.env.EXPO_ACCESS_TOKEN?.trim();

if (!expoAccessToken) {
  logger.warn(
    "EXPO_ACCESS_TOKEN is not set. Push delivery works without it unless enhanced push security is enabled in the EAS dashboard.",
  );
}

const expo = new Expo(
  expoAccessToken ? { accessToken: expoAccessToken } : undefined,
);

const APP_SCHEME = "com.mutualzz.app";
const DM_REPLY_CATEGORY_ID = "dm_reply";

interface NotifyChannel {
  id: string;
  type: ChannelType;
  spaceId?: string | null;
}

export interface MessagePushContext {
  message: APIMessage;
  channel: NotifyChannel;
  authorId: string;
  authorName: string;
  authorAvatar: PushAuthorAvatar;
  userMentionIds: string[];
  roleMentionIds: string[];
  everyoneMentioned: boolean;
  hereMentioned: boolean;
}

function shouldPushForPresence(status: string): boolean {
  if (status === "dnd" || status === "invisible") return false;
  return status === "idle" || status === "offline";
}

function buildNotificationUrl(channel: NotifyChannel): string {
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
    return `${APP_SCHEME}://@me/${channel.id}`;
  }

  return `${APP_SCHEME}://spaces/channel/${channel.id}`;
}

async function resolveRecipientIds(
  ctx: MessagePushContext,
): Promise<Set<string>> {
  const recipients = new Set<string>();
  const isDm =
    ctx.channel.type === ChannelType.DM ||
    ctx.channel.type === ChannelType.GroupDM;

  if (isDm) {
    const rows = await db
      .select({ userId: channelRecipientsTable.userId })
      .from(channelRecipientsTable)
      .where(eq(channelRecipientsTable.channelId, BigInt(ctx.channel.id)));

    for (const row of rows) {
      const userId = row.userId.toString();
      if (userId !== ctx.authorId) recipients.add(userId);
    }

    return recipients;
  }

  for (const userId of ctx.userMentionIds) {
    if (userId !== ctx.authorId) recipients.add(userId);
  }

  if (ctx.roleMentionIds.length > 0 && ctx.channel.spaceId) {
    const uniqueRoleIds = Array.from(new Set(ctx.roleMentionIds));
    const roleMembers = await db
      .select({ userId: spaceMemberRolesTable.userId })
      .from(spaceMemberRolesTable)
      .where(
        sql`${spaceMemberRolesTable.roleId} = ANY(ARRAY[${sql.raw(uniqueRoleIds.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
      );

    for (const row of roleMembers) {
      const userId = row.userId.toString();
      if (userId !== ctx.authorId) recipients.add(userId);
    }
  }

  if ((ctx.everyoneMentioned || ctx.hereMentioned) && ctx.channel.spaceId) {
    const allMembers = await db
      .select({ userId: spaceMembersTable.userId })
      .from(spaceMembersTable)
      .where(eq(spaceMembersTable.spaceId, BigInt(ctx.channel.spaceId)));

    const memberIds = allMembers
      .map((member) => member.userId.toString())
      .filter((userId) => userId !== ctx.authorId);

    if (ctx.everyoneMentioned) {
      for (const userId of memberIds) recipients.add(userId);
    } else if (ctx.hereMentioned) {
      const presences = await Promise.all(
        memberIds.map((id) => PresenceService.get(id)),
      );

      for (let index = 0; index < memberIds.length; index++) {
        const presence = presences[index];
        if (!unavailableLike(presence ?? null)) {
          recipients.add(memberIds[index]);
        }
      }
    }
  }

  return recipients;
}

interface UserPushSettings {
  pushEnabled: boolean;
  pushDirectMessages: boolean;
  pushMentions: boolean;
}

const DEFAULT_PUSH_SETTINGS: UserPushSettings = {
  pushEnabled: true,
  pushDirectMessages: true,
  pushMentions: true,
};

async function getPushSettingsForUsers(
  userIds: string[],
): Promise<Map<string, UserPushSettings>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      userId: userSettingsTable.userId,
      pushEnabled: userSettingsTable.pushEnabled,
      pushDirectMessages: userSettingsTable.pushDirectMessages,
      pushMentions: userSettingsTable.pushMentions,
    })
    .from(userSettingsTable)
    .where(
      sql`${userSettingsTable.userId} = ANY(ARRAY[${sql.raw(userIds.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
    );

  const settingsByUser = new Map<string, UserPushSettings>();

  for (const row of rows) {
    settingsByUser.set(row.userId.toString(), {
      pushEnabled: row.pushEnabled,
      pushDirectMessages: row.pushDirectMessages,
      pushMentions: row.pushMentions,
    });
  }

  return settingsByUser;
}

function shouldSendPushForSettings(
  settings: UserPushSettings,
  isDm: boolean,
): boolean {
  if (!settings.pushEnabled) return false;
  if (isDm) return settings.pushDirectMessages;
  return settings.pushMentions;
}

async function getTokensForUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return new Map<string, { token: string; platform: string }[]>();
  }

  const rows = await db
    .select({
      userId: pushTokensTable.userId,
      token: pushTokensTable.token,
      platform: pushTokensTable.platform,
    })
    .from(pushTokensTable)
    .where(
      sql`${pushTokensTable.userId} = ANY(ARRAY[${sql.raw(userIds.map((id) => `'${BigInt(id)}'`).join(","))}]::bigint[])`,
    );

  const tokensByUser = new Map<string, { token: string; platform: string }[]>();

  for (const row of rows) {
    const userId = row.userId.toString();
    const existing = tokensByUser.get(userId) ?? [];
    existing.push({
      token: row.token,
      platform: row.platform,
    });
    tokensByUser.set(userId, existing);
  }

  return tokensByUser;
}

async function removeInvalidTokens(tokens: string[]) {
  if (tokens.length === 0) return;

  await db
    .delete(pushTokensTable)
    .where(
      sql`${pushTokensTable.token} = ANY(ARRAY[${sql.raw(tokens.map((token) => `'${token.replace(/'/g, "''")}'`).join(","))}]::text[])`,
    );
}

async function deliverPushMessages(messages: ExpoPushMessage[]) {
  const validMessages = messages.filter((message) =>
    Expo.isExpoPushToken(message.to),
  );

  if (validMessages.length === 0) return;

  const chunks = expo.chunkPushNotifications(validMessages);
  const invalidTokens: string[] = [];

  for (const chunk of chunks) {
    let tickets: ExpoPushTicket[];
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      logger.warn("Failed to send push notification chunk", {
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    tickets.forEach((ticket, index) => {
      if (ticket.status !== "error") return;

      const token = chunk[index]?.to;
      if (
        token &&
        typeof token === "string" &&
        ticket.details?.error === "DeviceNotRegistered"
      ) {
        invalidTokens.push(token);
        return;
      }

      if (ticket.details?.error === "InvalidCredentials") {
        logger.error(
          "Expo push rejected request. Set EXPO_ACCESS_TOKEN if enhanced push security is enabled in EAS.",
          {
            message: ticket.message,
          },
        );
      }
    });
  }

  if (invalidTokens.length > 0) {
    await removeInvalidTokens(invalidTokens);
  }
}

export async function sendMessagePushNotifications(
  ctx: MessagePushContext,
): Promise<void> {
  const recipientIds = await resolveRecipientIds(ctx);
  if (recipientIds.size === 0) return;

  const tokensByUser = await getTokensForUsers([...recipientIds]);
  if (tokensByUser.size === 0) return;

  const pushSettingsByUser = await getPushSettingsForUsers([...recipientIds]);
  const isDm =
    ctx.channel.type === ChannelType.DM ||
    ctx.channel.type === ChannelType.GroupDM;

  const title = ctx.authorName;
  const subtitle = isDm ? undefined : "Mentioned you";
  const body = formatPushNotificationBody(
    ctx.message.content,
    ctx.authorName,
  );
  const authorAvatarUrl = buildAuthorAvatarUrl(ctx.authorAvatar);
  const url = buildNotificationUrl(ctx.channel);
  const messages: ExpoPushMessage[] = [];

  await Promise.all(
    [...recipientIds].map(async (userId) => {
      const tokens = tokensByUser.get(userId);
      if (!tokens?.length) return;

      const pushSettings =
        pushSettingsByUser.get(userId) ?? DEFAULT_PUSH_SETTINGS;

      if (!shouldSendPushForSettings(pushSettings, isDm)) return;

      const presence = await PresenceService.get(userId);
      const status = presence?.status ?? "offline";

      if (!shouldPushForPresence(status)) return;

      for (const { token, platform } of tokens) {
        const isIos = platform === "ios";
        const sharedData = {
          displayMode: MESSAGE_PUSH_DISPLAY_MODE,
          url,
          channelId: ctx.channel.id,
          conversationId: ctx.channel.id,
          senderId: ctx.authorId,
          senderName: ctx.authorName,
          authorAvatarUrl: authorAvatarUrl ?? "",
          title,
          body,
          subtitle: subtitle ?? "",
          pushType: isDm ? "dm" : "mention",
        };

        if (isIos) {
          messages.push({
            to: token,
            sound: "default",
            title,
            ...(subtitle ? { subtitle } : {}),
            body,
            mutableContent: true,
            ...(isDm ? { categoryId: DM_REPLY_CATEGORY_ID } : {}),
            data: sharedData,
          });
          continue;
        }

        messages.push({
          to: token,
          priority: "high",
          channelId: ANDROID_MESSAGE_CHANNEL_ID,
          _contentAvailable: true,
          data: sharedData,
        });
      }
    }),
  );

  await deliverPushMessages(messages);
}

export async function deletePushTokensForUser(
  userId: string,
  token?: string,
): Promise<void> {
  if (token) {
    await db
      .delete(pushTokensTable)
      .where(
        and(
          eq(pushTokensTable.userId, BigInt(userId)),
          eq(pushTokensTable.token, token),
        ),
      );
    return;
  }

  await db
    .delete(pushTokensTable)
    .where(eq(pushTokensTable.userId, BigInt(userId)));
}

export async function upsertPushToken(
  userId: string,
  token: string,
  platform: "ios" | "android",
): Promise<void> {
  if (!Expo.isExpoPushToken(token)) {
    throw new Error("Invalid Expo push token");
  }

  await db
    .insert(pushTokensTable)
    .values({
      userId: BigInt(userId),
      token,
      platform,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pushTokensTable.userId, pushTokensTable.token],
      set: {
        platform,
        updatedAt: new Date(),
      },
    });
}
