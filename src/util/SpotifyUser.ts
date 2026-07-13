import {
  db,
  userSpotifyConnectionsTable,
} from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-private",
].join(" ");

const STATE_TTL_SEC = 600;
const STATE_PREFIX = "spotify:oauth:";

export type SpotifyConnectionPublic = {
  connected: true;
  displayName: string | null;
  externalUrl: string | null;
  shareSpotify: boolean;
  available: boolean;
  expired?: boolean;
};

export type SpotifyConnectionStatus =
  | { connected: false; available: boolean }
  | SpotifyConnectionPublic;

export function isSpotifyConfigured() {
  return Boolean(
    process.env.SPOTIFY_CLIENT_ID?.trim() &&
      process.env.SPOTIFY_CLIENT_SECRET?.trim(),
  );
}

export function isSpotifyConnectEnabled() {
  return process.env.SPOTIFY_CONNECT_ENABLED === "true";
}

export function isSpotifyAvailable() {
  return isSpotifyConfigured() && isSpotifyConnectEnabled();
}

export type SpotifyCurrentlyPlaying = {
  name: "Spotify";
  details: string;
  state: string;
  timestamps: { start: number; end: number };
  assets?: {
    largeImageUrl?: string;
    largeText?: string;
  };
  url?: string;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUrl?: string;
  spotifyUri?: string;
};

function requireSpotifyEnv() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "Spotify is not configured",
    );
  }
  return { clientId, clientSecret };
}

function frontendOrigin() {
  const frontend = process.env.FRONTEND_URL?.trim().replace(/\/$/, "");
  if (!frontend) {
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "FRONTEND_URL is not configured",
    );
  }
  return frontend;
}

function toLoopbackRedirectOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.origin;
  } catch {
    return origin.replace("://localhost", "://127.0.0.1");
  }
}

function toLocalhostRedirectOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
    }
    return url.origin;
  } catch {
    return origin.replace("://127.0.0.1", "://localhost");
  }
}

function redirectUri() {
  const explicit = process.env.SPOTIFY_REDIRECT_URI?.trim();
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : `${frontendOrigin()}/spotify/callback`;
  try {
    const url = new URL(base);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return `${url.origin}${url.pathname}`.replace(/\/$/, "") || url.href;
  } catch {
    return base.replace("://localhost", "://127.0.0.1");
  }
}

function isAllowedReturnTo(returnTo: string): boolean {
  if (returnTo === "mutualzz://spotify/connected") return true;
  const frontend = frontendOrigin();
  const allowedOrigins = new Set([
    new URL(frontend).origin,
    toLoopbackRedirectOrigin(frontend),
    toLocalhostRedirectOrigin(frontend),
  ]);
  try {
    const url = new URL(returnTo);
    if (allowedOrigins.has(url.origin)) return true;
  } catch {
    return false;
  }
  return false;
}

async function spotifyTokenRequest(
  body: URLSearchParams,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const { clientId, clientSecret } = requireSpotifyEnv();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `Spotify token error: ${res.status} ${text}`,
    );
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

async function spotifyApi(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

export async function createSpotifyAuthorizeUrl(opts: {
  userId: string;
  returnTo: string;
}): Promise<string> {
  if (!isSpotifyConnectEnabled()) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "Spotify connect is temporarily unavailable",
    );
  }
  const { clientId } = requireSpotifyEnv();
  if (!isAllowedReturnTo(opts.returnTo)) {
    throw new HttpException(HttpStatusCode.BadRequest, "Invalid returnTo");
  }

  const nonce = crypto.randomBytes(24).toString("hex");
  await redis.set(
    `${STATE_PREFIX}${nonce}`,
    JSON.stringify({ userId: opts.userId, returnTo: opts.returnTo }),
    "EX",
    STATE_TTL_SEC,
  );

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state: nonce,
    show_dialog: "false",
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

export async function handleSpotifyOAuthCallback(opts: {
  code: string;
  state: string;
}): Promise<string> {
  const raw = await redis.get(`${STATE_PREFIX}${opts.state}`);
  if (raw) await redis.del(`${STATE_PREFIX}${opts.state}`);
  if (!raw) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid or expired OAuth state",
    );
  }

  const parsed = JSON.parse(raw) as { userId: string; returnTo: string };
  const token = await spotifyTokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: redirectUri(),
    }),
  );

  if (!token.refresh_token) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Spotify did not return a refresh token",
    );
  }

  const meRes = await spotifyApi(token.access_token, "GET", "/me");
  if (!meRes.ok) {
    const text = await meRes.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `Failed to fetch Spotify profile: ${meRes.status} ${text}`,
    );
  }
  const me = (await meRes.json()) as {
    id: string;
    display_name?: string | null;
    external_urls?: { spotify?: string };
  };

  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const userId = BigInt(parsed.userId);

  await db
    .insert(userSpotifyConnectionsTable)
    .values({
      userId,
      spotifyUserId: me.id,
      displayName: me.display_name ?? null,
      externalUrl: me.external_urls?.spotify ?? null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt,
      shareSpotify: true,
    })
    .onConflictDoUpdate({
      target: userSpotifyConnectionsTable.userId,
      set: {
        spotifyUserId: me.id,
        displayName: me.display_name ?? null,
        externalUrl: me.external_urls?.spotify ?? null,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
      },
    });

  return parsed.returnTo;
}

async function getConnectionRow(userId: bigint) {
  return db.query.userSpotifyConnectionsTable.findFirst({
    where: eq(userSpotifyConnectionsTable.userId, userId),
  });
}

async function ensureAccessToken(userId: bigint): Promise<{
  accessToken: string;
  connection: typeof userSpotifyConnectionsTable.$inferSelect;
}> {
  const connection = await getConnectionRow(userId);
  if (!connection) {
    throw new HttpException(HttpStatusCode.NotFound, "Spotify not connected");
  }

  if (connection.expiresAt.getTime() > Date.now() + 60_000) {
    return { accessToken: connection.accessToken, connection };
  }

  try {
    const token = await spotifyTokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
      }),
    );

    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    const refreshToken = token.refresh_token ?? connection.refreshToken;

    const [updated] = await db
      .update(userSpotifyConnectionsTable)
      .set({
        accessToken: token.access_token,
        refreshToken,
        expiresAt,
      })
      .where(eq(userSpotifyConnectionsTable.userId, userId))
      .returning();

    return {
      accessToken: token.access_token,
      connection: updated ?? {
        ...connection,
        accessToken: token.access_token,
        refreshToken,
        expiresAt,
      },
    };
  } catch {
    await db
      .delete(userSpotifyConnectionsTable)
      .where(eq(userSpotifyConnectionsTable.userId, userId));
    throw new HttpException(
      HttpStatusCode.Unauthorized,
      "Spotify auth expired",
    );
  }
}

export async function getOwnSpotifyConnection(
  userId: string,
): Promise<SpotifyConnectionStatus> {
  const available = isSpotifyAvailable();
  const row = await getConnectionRow(BigInt(userId));
  if (!row) return { connected: false, available };

  let expired = false;
  if (row.expiresAt.getTime() <= Date.now() + 60_000) {
    try {
      await ensureAccessToken(BigInt(userId));
    } catch {
      return { connected: false, available };
    }
  }

  const fresh = await getConnectionRow(BigInt(userId));
  if (!fresh) return { connected: false, available };

  return {
    connected: true,
    displayName: fresh.displayName,
    externalUrl: fresh.externalUrl,
    shareSpotify: fresh.shareSpotify,
    available,
    expired,
  };
}

export async function getPublicSpotifyConnection(
  userId: string,
): Promise<{ displayName: string | null; externalUrl: string | null } | null> {
  const row = await getConnectionRow(BigInt(userId));
  if (!row || !row.shareSpotify) return null;
  return {
    displayName: row.displayName,
    externalUrl: row.externalUrl,
  };
}

export async function updateShareSpotify(
  userId: string,
  shareSpotify: boolean,
): Promise<SpotifyConnectionStatus> {
  const [row] = await db
    .update(userSpotifyConnectionsTable)
    .set({ shareSpotify })
    .where(eq(userSpotifyConnectionsTable.userId, BigInt(userId)))
    .returning();
  if (!row) {
    throw new HttpException(HttpStatusCode.NotFound, "Spotify not connected");
  }
  return {
    connected: true as const,
    displayName: row.displayName,
    externalUrl: row.externalUrl,
    shareSpotify: row.shareSpotify,
    available: isSpotifyAvailable(),
  };
}

export async function disconnectSpotify(userId: string) {
  await db
    .delete(userSpotifyConnectionsTable)
    .where(eq(userSpotifyConnectionsTable.userId, BigInt(userId)));
}

export async function getCurrentlyPlaying(
  userId: string,
): Promise<SpotifyCurrentlyPlaying | null> {
  const { accessToken } = await ensureAccessToken(BigInt(userId));

  const res = await spotifyApi(
    accessToken,
    "GET",
    "/me/player/currently-playing",
  );

  if (res.status === 204) return null;
  if (res.status === 401) {
    throw new HttpException(HttpStatusCode.Unauthorized, "Spotify auth expired");
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) return null;
    return null;
  }

  const data = (await res.json()) as {
    is_playing?: boolean;
    progress_ms?: number;
    item?: {
      name?: string;
      duration_ms?: number;
      uri?: string;
      external_urls?: { spotify?: string };
      artists?: Array<{ name?: string }>;
      album?: {
        name?: string;
        images?: Array<{ url?: string }>;
      };
    } | null;
    currently_playing_type?: string;
  };

  const item = data.item;
  if (!item?.name || data.currently_playing_type === "ad") return null;

  const durationMs = item.duration_ms ?? 0;
  const progressMs = data.progress_ms ?? 0;
  const now = Date.now();
  const start = now - progressMs;
  const end = start + durationMs;
  const artists =
    item.artists
      ?.map((a) => a.name)
      .filter(Boolean)
      .join(", ") || "Unknown Artist";
  const images = item.album?.images ?? [];
  const largeImageUrl = images[0]?.url ?? images.at(-1)?.url;

  return {
    name: "Spotify",
    details: item.name,
    state: artists,
    timestamps: { start, end },
    ...(largeImageUrl || item.album?.name
      ? {
          assets: {
            ...(largeImageUrl ? { largeImageUrl } : {}),
            ...(item.album?.name ? { largeText: item.album.name } : {}),
          },
        }
      : {}),
    ...(item.external_urls?.spotify
      ? { url: item.external_urls.spotify, trackUrl: item.external_urls.spotify }
      : {}),
    ...(item.uri ? { spotifyUri: item.uri } : {}),
    isPlaying: data.is_playing === true,
    progressMs,
    durationMs,
  };
}

async function playbackAction(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const { accessToken } = await ensureAccessToken(BigInt(userId));
  const res = await spotifyApi(accessToken, method, path, body);
  if (res.status === 204 || res.ok) return;
  if (res.status === 403) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "Spotify Premium is required for playback control",
    );
  }
  if (res.status === 404) {
    throw new HttpException(
      HttpStatusCode.NotFound,
      "No active Spotify device",
    );
  }
  const text = await res.text().catch(() => "");
  throw new HttpException(
    HttpStatusCode.BadRequest,
    `Spotify playback error: ${res.status} ${text}`,
  );
}

export async function spotifyPlay(userId: string) {
  await playbackAction(userId, "PUT", "/me/player/play");
}

export async function spotifyPause(userId: string) {
  await playbackAction(userId, "PUT", "/me/player/pause");
}

export async function spotifyNext(userId: string) {
  await playbackAction(userId, "POST", "/me/player/next");
}

export async function spotifyPrevious(userId: string) {
  await playbackAction(userId, "POST", "/me/player/previous");
}

export async function spotifySeek(userId: string, positionMs: number) {
  const ms = Math.max(0, Math.floor(positionMs));
  await playbackAction(userId, "PUT", `/me/player/seek?position_ms=${ms}`);
}
