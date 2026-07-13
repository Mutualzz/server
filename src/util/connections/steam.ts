import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { ConnectionProfile, StartOAuthResult } from "./types.ts";
import { connectionsRedirectUri } from "./shared.ts";

export function isSteamConfigured() {
  return Boolean(process.env.STEAM_API_KEY?.trim());
}

export function createSteamAuthorizeUrl(state: string): StartOAuthResult {
  const returnTo = new URL(connectionsRedirectUri());
  returnTo.searchParams.set("provider", "steam");
  returnTo.searchParams.set("state", state);

  const realm =
    process.env.STEAM_REALM?.trim() ||
    `${returnTo.protocol}//${returnTo.host}/`;

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo.toString(),
    "openid.realm": realm,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return {
    url: `https://steamcommunity.com/openid/login?${params.toString()}`,
  };
}

function extractSteamId(claimedId: string): string | null {
  const match = claimedId.match(
    /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/,
  );
  return match?.[1] ?? null;
}

export async function completeSteamOpenId(
  openid: Record<string, string>,
): Promise<ConnectionProfile> {
  const claimedId = openid["openid.claimed_id"] || openid.claimed_id;
  if (!claimedId) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Missing Steam OpenID claimed_id",
    );
  }

  const steamId = extractSteamId(claimedId);
  if (!steamId) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid Steam OpenID claimed_id",
    );
  }

  const verifyParams = new URLSearchParams();
  for (const [key, value] of Object.entries(openid)) {
    const openidKey = key.startsWith("openid.") ? key : `openid.${key}`;
    verifyParams.set(openidKey, value);
  }
  verifyParams.set("openid.mode", "check_authentication");

  const verifyRes = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verifyParams,
  });
  const verifyText = await verifyRes.text();
  if (!verifyText.includes("is_valid:true")) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Steam OpenID verification failed",
    );
  }

  const apiKey = process.env.STEAM_API_KEY!.trim();
  try {
    const summaryRes = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamId)}`,
    );
    if (summaryRes.ok) {
      const summary = (await summaryRes.json()) as {
        response?: {
          players?: Array<{
            steamid: string;
            personaname?: string;
            profileurl?: string;
          }>;
        };
      };
      const player = summary.response?.players?.[0];
      if (player) {
        return {
          providerUserId: steamId,
          displayName: player.personaname ?? steamId,
          externalUrl:
            player.profileurl ??
            `https://steamcommunity.com/profiles/${steamId}`,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
        };
      }
    }
  } catch {
  }

  return {
    providerUserId: steamId,
    displayName: steamId,
    externalUrl: `https://steamcommunity.com/profiles/${steamId}`,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  };
}
