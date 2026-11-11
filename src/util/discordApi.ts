import { permissionFlags } from "@mutualzz/bitfield";
import { ChannelType } from "@mutualzz/types";
import {
  ChannelType as DiscordChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  REST,
  Routes,
} from "discord.js";

const DISCORD_API = "https://discord.com/api/v10";

let discordBotRest: REST | null = null;

function botRest() {
  if (discordBotRest) return discordBotRest;
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not defined");
  discordBotRest = new REST({ version: "10" }).setToken(token);
  return discordBotRest;
}

export interface DiscordOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  guild?: DiscordGuild;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  banner?: string | null;
  accent_color?: number | null;
  email?: string | null;
}

export interface DiscordUserProfile {
  bio?: string | null;
}

export interface DiscordGuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  permission_overwrites?: DiscordPermissionOverwrite[];
}

export interface DiscordPermissionOverwrite {
  id: string;
  type: OverwriteType;
  allow: string;
  deny: string;
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
}

export interface DiscordGuildEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

export const DiscordStickerFormat = {
  Png: 1,
  Apng: 2,
  Lottie: 3,
  Gif: 4,
} as const;

export interface DiscordGuildSticker {
  id: string;
  name: string;
  format_type: number;
  available?: boolean;
}

export type DiscordAuthPurpose = "auth" | "import";

const DISCORD_ADMINISTRATOR_PERMISSION = PermissionFlagsBits.Administrator;

export function discordAuthorizeUrl(
  state: string,
  redirectUri: string,
  purpose: DiscordAuthPurpose = "auth",
) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is not defined");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  if (purpose === "import") {
    params.set("scope", "bot identify");
    params.set("permissions", DISCORD_ADMINISTRATOR_PERMISSION.toString());
  } else {
    params.set("scope", "identify email guilds");
    params.set("prompt", "consent");
  }

  return `https://discord.com/api/oauth2/authorize?${params}`;
}

export async function exchangeDiscordCode(
  code: string,
  redirectUri: string,
): Promise<DiscordOAuthTokens> {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Discord OAuth is not configured");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const failureDetails = await res.text().catch(() => "");
    throw new Error(
      `Discord token exchange failed (${res.status}): ${failureDetails}`,
    );
  }

  return res.json() as Promise<DiscordOAuthTokens>;
}

export async function fetchDiscordUser(
  accessToken: string,
): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`Discord user fetch failed (${res.status})`);
  return res.json() as Promise<DiscordUser>;
}

export async function fetchDiscordUserProfile(
  accessToken: string,
): Promise<DiscordUserProfile> {
  const res = await fetch(`${DISCORD_API}/users/@me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) return { bio: null };
  return res.json() as Promise<DiscordUserProfile>;
}

export function discordAvatarUrl(user: DiscordUser) {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
}

export function discordBannerUrl(user: DiscordUser) {
  if (!user.banner) return null;
  const ext = user.banner.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${ext}?size=512`;
}

export function fetchDiscordGuild(guildId: string) {
  return botRest().get(Routes.guild(guildId)) as Promise<DiscordGuild>;
}

export function fetchDiscordGuildChannels(guildId: string) {
  return botRest().get(Routes.guildChannels(guildId)) as Promise<
    DiscordGuildChannel[]
  >;
}

export function fetchDiscordGuildRoles(guildId: string) {
  return botRest().get(Routes.guildRoles(guildId)) as Promise<
    DiscordGuildRole[]
  >;
}

export function fetchDiscordGuildEmojis(guildId: string) {
  return botRest().get(Routes.guildEmojis(guildId)) as Promise<
    DiscordGuildEmoji[]
  >;
}

export function fetchDiscordGuildStickers(guildId: string) {
  return botRest().get(Routes.guildStickers(guildId)) as Promise<
    DiscordGuildSticker[]
  >;
}

export async function fetchDiscordBotJoinedAt(guildId: string) {
  const botUser = (await botRest().get(Routes.user())) as { id: string };

  try {
    const botMember = (await botRest().get(
      Routes.guildMember(guildId, botUser.id),
    )) as { joined_at: string };
    return new Date(botMember.joined_at).getTime();
  } catch (error) {
    if (error instanceof DiscordAPIError) return null;
    throw error;
  }
}

export async function leaveDiscordGuild(guildId: string) {
  try {
    await botRest().delete(Routes.userGuild(guildId));
  } catch (error) {
    if (error instanceof DiscordAPIError && error.status === 404) return;
    throw error;
  }
}

export function isImportableDiscordSticker(sticker: DiscordGuildSticker) {
  return sticker.format_type !== DiscordStickerFormat.Lottie;
}

export function discordStickerUrl(sticker: DiscordGuildSticker) {
  if (sticker.format_type === DiscordStickerFormat.Gif)
    return `https://media.discordapp.net/stickers/${sticker.id}.gif`;
  return `https://cdn.discordapp.com/stickers/${sticker.id}.png`;
}

export function isDiscordChannelPrivate(
  channel: DiscordGuildChannel,
  guildId: string,
) {
  const everyoneOverwrite = channel.permission_overwrites?.find(
    (overwrite) =>
      overwrite.type === OverwriteType.Role && overwrite.id === guildId,
  );
  if (!everyoneOverwrite) return false;
  return (
    (BigInt(everyoneOverwrite.deny) & PermissionFlagsBits.ViewChannel) ===
    PermissionFlagsBits.ViewChannel
  );
}

export function discordGuildIconUrl(guild: DiscordGuild, size = 128) {
  if (!guild.icon) return null;
  const extension = guild.icon.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${extension}?size=${size}`;
}

export function mapDiscordChannelType(type: number): ChannelType | null {
  if (type === DiscordChannelType.GuildText) return ChannelType.Text;
  if (type === DiscordChannelType.GuildVoice) return ChannelType.Voice;
  if (type === DiscordChannelType.GuildCategory) return ChannelType.Category;
  return null;
}

function discordChannelSortGroup(type: number) {
  if (type === DiscordChannelType.GuildCategory) return 2;
  if (
    type === DiscordChannelType.GuildVoice ||
    type === DiscordChannelType.GuildStageVoice
  )
    return 1;
  return 0;
}

export function sortDiscordChannelsForDisplay(channels: DiscordGuildChannel[]) {
  return [...channels].sort(
    (first, second) =>
      discordChannelSortGroup(first.type) -
        discordChannelSortGroup(second.type) ||
      first.position - second.position ||
      Number(BigInt(first.id) - BigInt(second.id)),
  );
}

const DISCORD_TO_MUTUALZZ_PERMISSIONS: [bigint, bigint][] = [
  [PermissionFlagsBits.ViewChannel, permissionFlags.ViewChannel],
  [PermissionFlagsBits.SendMessages, permissionFlags.SendMessages],
  [PermissionFlagsBits.ManageMessages, permissionFlags.ManageMessages],
  [PermissionFlagsBits.EmbedLinks, permissionFlags.EmbedLinks],
  [PermissionFlagsBits.AttachFiles, permissionFlags.AttachFiles],
  [PermissionFlagsBits.ReadMessageHistory, permissionFlags.ReadMessageHistory],
  [PermissionFlagsBits.MentionEveryone, permissionFlags.MentionEveryone],
  [PermissionFlagsBits.UseExternalEmojis, permissionFlags.UseExternalEmojis],
  [PermissionFlagsBits.AddReactions, permissionFlags.AddReactions],
  [PermissionFlagsBits.Connect, permissionFlags.Connect],
  [PermissionFlagsBits.Speak, permissionFlags.Speak],
  [PermissionFlagsBits.MuteMembers, permissionFlags.MuteMembers],
  [PermissionFlagsBits.DeafenMembers, permissionFlags.DeafenMembers],
  [PermissionFlagsBits.MoveMembers, permissionFlags.MoveMembers],
  [PermissionFlagsBits.ManageChannels, permissionFlags.ManageChannels],
  [PermissionFlagsBits.ManageRoles, permissionFlags.ManageRoles],
  [PermissionFlagsBits.ManageGuild, permissionFlags.ManageSpace],
  [PermissionFlagsBits.KickMembers, permissionFlags.KickMembers],
  [PermissionFlagsBits.BanMembers, permissionFlags.BanMembers],
  [PermissionFlagsBits.CreateInstantInvite, permissionFlags.CreateInvites],
  [PermissionFlagsBits.PinMessages, permissionFlags.PinMessages],
];

export function mapDiscordPermissions(raw: string) {
  const discordPermissions = BigInt(raw);
  let mutualzzPermissions = 0n;

  for (const [discordBit, mutualzzBit] of DISCORD_TO_MUTUALZZ_PERMISSIONS) {
    if ((discordPermissions & discordBit) === discordBit)
      mutualzzPermissions |= mutualzzBit;
  }

  return mutualzzPermissions;
}

export function discordEmojiUrl(emoji: DiscordGuildEmoji) {
  const ext = emoji.animated ? "gif" : "png";
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
}
