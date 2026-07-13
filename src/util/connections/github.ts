import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { ConnectionProfile, StartOAuthResult } from "./types.ts";
import { connectionsRedirectUri } from "./shared.ts";

export function isGithubConfigured() {
  return Boolean(
    process.env.GITHUB_CLIENT_ID?.trim() &&
      process.env.GITHUB_CLIENT_SECRET?.trim(),
  );
}

export function createGithubAuthorizeUrl(state: string): StartOAuthResult {
  const clientId = process.env.GITHUB_CLIENT_ID!.trim();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: connectionsRedirectUri(),
    scope: "read:user",
    state,
    allow_signup: "true",
  });
  return {
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  };
}

export async function exchangeGithubCode(
  code: string,
): Promise<ConnectionProfile> {
  const clientId = process.env.GITHUB_CLIENT_ID!.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET!.trim();

  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: connectionsRedirectUri(),
      }),
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `GitHub token error: ${tokenRes.status} ${text}`,
    );
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenJson.access_token) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      tokenJson.error_description || tokenJson.error || "GitHub token missing",
    );
  }

  const meRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Mutualzz",
    },
  });
  if (!meRes.ok) {
    const text = await meRes.text().catch(() => "");
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `Failed to fetch GitHub profile: ${meRes.status} ${text}`,
    );
  }
  const me = (await meRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    html_url?: string;
  };

  return {
    providerUserId: String(me.id),
    displayName: me.name?.trim() || me.login,
    externalUrl: me.html_url ?? `https://github.com/${me.login}`,
    accessToken: tokenJson.access_token,
    refreshToken: null,
    expiresAt: null,
  };
}
