import { permissionFlags } from "@mutualzz/bitfield";
import { ChannelType } from "@mutualzz/types";

const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
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
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
}

export interface DiscordGuildEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

export function discordBotInviteUrl() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is not defined");

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "bot",
    permissions: "1342178304",
  });

  return `https://discord.com/api/oauth2/authorize?${params}`;
}

export function discordAuthorizeUrl(state: string, redirectUri: string) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error("DISCORD_CLIENT_ID is not defined");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify email guilds",
    state,
    prompt: "consent",
  });

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
    throw new Error(`Discord token exchange failed (${res.status})`);
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

export async function fetchDiscordGuildChannels(guildId: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not defined");

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) throw new Error(`Discord guild channels failed (${res.status})`);
  return res.json() as Promise<DiscordGuildChannel[]>;
}

export async function fetchDiscordGuildRoles(guildId: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not defined");

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) throw new Error(`Discord guild roles failed (${res.status})`);
  return res.json() as Promise<DiscordGuildRole[]>;
}

export async function fetchDiscordGuildEmojis(guildId: string) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not defined");

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/emojis`, {
    headers: { Authorization: `Bot ${token}` },
  });

  if (!res.ok) throw new Error(`Discord guild emojis failed (${res.status})`);
  return res.json() as Promise<DiscordGuildEmoji[]>;
}

export function mapDiscordChannelType(type: number): ChannelType | null {
  if (type === 0) return ChannelType.Text;
  if (type === 2) return ChannelType.Voice;
  if (type === 4) return ChannelType.Category;
  return null;
}

const DISCORD_TO_MUTUALZZ: Record<string, bigint> = {
  VIEW_CHANNEL: permissionFlags.ViewChannel,
  SEND_MESSAGES: permissionFlags.SendMessages,
  MANAGE_MESSAGES: permissionFlags.ManageMessages,
  EMBED_LINKS: permissionFlags.EmbedLinks,
  ATTACH_FILES: permissionFlags.AttachFiles,
  READ_MESSAGE_HISTORY: permissionFlags.ReadMessageHistory,
  MENTION_EVERYONE: permissionFlags.MentionEveryone,
  USE_EXTERNAL_EMOJIS: permissionFlags.UseExternalEmojis,
  ADD_REACTIONS: permissionFlags.AddReactions,
  CONNECT: permissionFlags.Connect,
  SPEAK: permissionFlags.Speak,
  MUTE_MEMBERS: permissionFlags.MuteMembers,
  DEAFEN_MEMBERS: permissionFlags.DeafenMembers,
  MOVE_MEMBERS: permissionFlags.MoveMembers,
  MANAGE_CHANNELS: permissionFlags.ManageChannels,
  MANAGE_ROLES: permissionFlags.ManageRoles,
  MANAGE_GUILD: permissionFlags.ManageSpace,
  KICK_MEMBERS: permissionFlags.KickMembers,
  BAN_MEMBERS: permissionFlags.BanMembers,
  CREATE_INVITE: permissionFlags.CreateInvites,
  PIN_MESSAGES: permissionFlags.PinMessages,
};

export function mapDiscordPermissions(raw: string) {
  const value = BigInt(raw);
  let allow = 0n;

  for (const [name, bit] of Object.entries(DISCORD_TO_MUTUALZZ)) {
    const discordBit = discordPermissionBit(name);
    if (discordBit !== null && (value & discordBit) === discordBit) {
      allow |= bit;
    }
  }

  return allow;
}

function discordPermissionBit(name: string) {
  const bits: Record<string, bigint> = {
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    MENTION_EVERYONE: 1n << 17n,
    USE_EXTERNAL_EMOJIS: 1n << 18n,
    ADD_REACTIONS: 1n << 6n,
    CONNECT: 1n << 20n,
    SPEAK: 1n << 21n,
    MUTE_MEMBERS: 1n << 22n,
    DEAFEN_MEMBERS: 1n << 23n,
    MOVE_MEMBERS: 1n << 24n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_GUILD: 1n << 5n,
    KICK_MEMBERS: 1n << 1n,
    BAN_MEMBERS: 1n << 2n,
    CREATE_INVITE: 1n << 0n,
    PIN_MESSAGES: 1n << 50n,
  };

  return bits[name] ?? null;
}

export function discordEmojiUrl(emoji: DiscordGuildEmoji) {
  const ext = emoji.animated ? "gif" : "png";
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
}
