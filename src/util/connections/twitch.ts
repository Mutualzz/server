import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { ConnectionProfile, StartOAuthResult } from "./types.ts";
import { connectionsRedirectUri } from "./shared.ts";

export function isTwitchConfigured() {
  return Boolean(
    process.env.TWITCH_CLIENT_ID?.trim() &&
      process.env.TWITCH_CLIENT_SECRET?.trim(),
  );
}

export function createTwitchAuthorizeUrl(state: string): StartOAuthResult {
  const clientId = process.env.TWITCH_CLIENT_ID!.trim();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: connectionsRedirectUri(),
    response_type: "code",
    scope: "user:read:email",
    state,
  });
  return {
    url: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`,
  };
}

export async function exchangeTwitchCode(
  code: string,
): Promise<ConnectionProfile> {
  const clientId = process.env.TWITCH_CLIENT_ID!.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET!.trim();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: connectionsRedirectUri(),
  });
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `Twitch token error: ${tokenRes.status} ${text}`,
    );
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const meRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "Client-Id": clientId,
    },
  });
  if (!meRes.ok) {
    const text = await meRes.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `Failed to fetch Twitch profile: ${meRes.status} ${text}`,
    );
  }
  const meJson = (await meRes.json()) as {
    data?: Array<{
      id: string;
      login: string;
      display_name?: string;
    }>;
  };
  const me = meJson.data?.[0];
  if (!me) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Twitch profile missing",
    );
  }

  return {
    providerUserId: me.id,
    displayName: me.display_name || me.login,
    externalUrl: `https://twitch.tv/${me.login}`,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt: new Date(Date.now() + tokenJson.expires_in * 1000),
  };
}

export async function refreshTwitchToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
} | null> {
  if (!isTwitchConfigured()) return null;
  const clientId = process.env.TWITCH_CLIENT_ID!.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET!.trim();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) return null;
  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + tokenJson.expires_in * 1000),
  };
}
