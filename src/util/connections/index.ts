import {
  db,
  userConnectionsTable,
} from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import crypto from "crypto";
import {
  createGithubAuthorizeUrl,
  exchangeGithubCode,
  isGithubConfigured,
} from "./github.ts";
import {
  completeSteamOpenId,
  createSteamAuthorizeUrl,
  isSteamConfigured,
} from "./steam.ts";
import {
  createTwitchAuthorizeUrl,
  exchangeTwitchCode,
  isTwitchConfigured,
  refreshTwitchToken,
} from "./twitch.ts";
import {
  CONNECTION_PROVIDERS,
  type CompleteOAuthInput,
  type ConnectionProfile,
  type ConnectionProvider,
  type OAuthStatePayload,
  type ProviderConnectionView,
  type PublicConnectionView,
  isConnectionProvider,
} from "./types.ts";
import {
  STATE_PREFIX,
  STATE_TTL_SEC,
  isAllowedReturnTo,
  providerEnvConfigured,
} from "./shared.ts";
import { isSpotifyAvailable } from "../SpotifyUser.ts";

export {
  CONNECTION_PROVIDERS,
  isConnectionProvider,
  type ConnectionProvider,
  type ProviderConnectionView,
  type PublicConnectionView,
};

function assertProviderAvailable(provider: ConnectionProvider) {
  if (!providerEnvConfigured(provider)) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      `${provider} is not configured`,
    );
  }
}

async function saveState(payload: OAuthStatePayload): Promise<string> {
  const nonce = crypto.randomBytes(24).toString("hex");
  await redis.set(
    `${STATE_PREFIX}${nonce}`,
    JSON.stringify(payload),
    "EX",
    STATE_TTL_SEC,
  );
  return nonce;
}

async function takeState(state: string): Promise<OAuthStatePayload> {
  const raw = await redis.get(`${STATE_PREFIX}${state}`);
  if (raw) await redis.del(`${STATE_PREFIX}${state}`);
  if (!raw) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid or expired OAuth state",
    );
  }
  return JSON.parse(raw) as OAuthStatePayload;
}

async function upsertConnection(
  userId: string,
  provider: ConnectionProvider,
  profile: ConnectionProfile,
) {
  const userIdBig = BigInt(userId);

  const existingOther = await db.query.userConnectionsTable.findFirst({
    where: and(
      eq(userConnectionsTable.provider, provider),
      eq(userConnectionsTable.providerUserId, profile.providerUserId),
    ),
  });
  if (existingOther && existingOther.userId !== userIdBig) {
    throw new HttpException(
      HttpStatusCode.Conflict,
      "This account is already linked to another Mutualzz user",
    );
  }

  await db
    .insert(userConnectionsTable)
    .values({
      userId: userIdBig,
      provider,
      providerUserId: profile.providerUserId,
      displayName: profile.displayName,
      externalUrl: profile.externalUrl,
      accessToken: profile.accessToken ?? null,
      refreshToken: profile.refreshToken ?? null,
      expiresAt: profile.expiresAt ?? null,
      shareOnProfile: true,
    })
    .onConflictDoUpdate({
      target: [userConnectionsTable.userId, userConnectionsTable.provider],
      set: {
        providerUserId: profile.providerUserId,
        displayName: profile.displayName,
        externalUrl: profile.externalUrl,
        accessToken: profile.accessToken ?? null,
        refreshToken: profile.refreshToken ?? null,
        expiresAt: profile.expiresAt ?? null,
      },
    });
}

export async function listOwnConnections(
  userId: string,
): Promise<ProviderConnectionView[]> {
  await cleanupExpiredConnectionsForUser(userId);

  const rows = await db.query.userConnectionsTable.findMany({
    where: eq(userConnectionsTable.userId, BigInt(userId)),
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  return CONNECTION_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    const expired = Boolean(
      row?.expiresAt && row.expiresAt.getTime() <= Date.now(),
    );
    return {
      provider,
      available: providerEnvConfigured(provider),
      connected: Boolean(row),
      displayName: row?.displayName ?? null,
      externalUrl: row?.externalUrl ?? null,
      shareOnProfile: row?.shareOnProfile ?? true,
      expired,
    };
  });
}

export async function listPublicConnections(
  userId: string,
): Promise<PublicConnectionView[]> {
  const rows = await db.query.userConnectionsTable.findMany({
    where: and(
      eq(userConnectionsTable.userId, BigInt(userId)),
      eq(userConnectionsTable.shareOnProfile, true),
    ),
  });
  return rows
    .filter((row) => isConnectionProvider(row.provider))
    .map((row) => ({
      provider: row.provider as ConnectionProvider,
      displayName: row.displayName,
      externalUrl: row.externalUrl,
    }));
}

export async function createConnectionAuthorizeUrl(opts: {
  userId: string;
  provider: ConnectionProvider;
  returnTo: string;
}): Promise<{ url: string }> {
  assertProviderAvailable(opts.provider);
  if (!isAllowedReturnTo(opts.returnTo)) {
    throw new HttpException(HttpStatusCode.BadRequest, "Invalid returnTo");
  }

  const state = await saveState({
    userId: opts.userId,
    returnTo: opts.returnTo,
    provider: opts.provider,
  });

  switch (opts.provider) {
    case "github":
      return createGithubAuthorizeUrl(state);
    case "twitch":
      return createTwitchAuthorizeUrl(state);
    case "steam":
      return createSteamAuthorizeUrl(state);
    default:
      throw new HttpException(HttpStatusCode.BadRequest, "Unknown provider");
  }
}

export async function handleConnectionOAuthComplete(
  input: CompleteOAuthInput,
): Promise<{ returnTo: string; provider: ConnectionProvider }> {
  if (!input.state) {
    throw new HttpException(HttpStatusCode.BadRequest, "Missing state");
  }

  const payload = await takeState(input.state);
  const provider = payload.provider;
  if (input.provider && input.provider !== provider) {
    throw new HttpException(HttpStatusCode.BadRequest, "Provider mismatch");
  }
  assertProviderAvailable(provider);

  let profile: ConnectionProfile;
  switch (provider) {
    case "github": {
      if (!input.code) {
        throw new HttpException(HttpStatusCode.BadRequest, "Missing code");
      }
      profile = await exchangeGithubCode(input.code);
      break;
    }
    case "twitch": {
      if (!input.code) {
        throw new HttpException(HttpStatusCode.BadRequest, "Missing code");
      }
      profile = await exchangeTwitchCode(input.code);
      break;
    }
    case "steam": {
      if (!input.openid || Object.keys(input.openid).length === 0) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Missing Steam OpenID payload",
        );
      }
      profile = await completeSteamOpenId(input.openid);
      break;
    }
    default:
      throw new HttpException(HttpStatusCode.BadRequest, "Unknown provider");
  }

  await upsertConnection(payload.userId, provider, profile);
  return { returnTo: payload.returnTo, provider };
}

export async function updateConnectionShare(
  userId: string,
  provider: ConnectionProvider,
  shareOnProfile: boolean,
): Promise<ProviderConnectionView> {
  const [row] = await db
    .update(userConnectionsTable)
    .set({ shareOnProfile })
    .where(
      and(
        eq(userConnectionsTable.userId, BigInt(userId)),
        eq(userConnectionsTable.provider, provider),
      ),
    )
    .returning();
  if (!row) {
    throw new HttpException(HttpStatusCode.NotFound, "Connection not found");
  }
  return {
    provider,
    available: providerEnvConfigured(provider),
    connected: true,
    displayName: row.displayName,
    externalUrl: row.externalUrl,
    shareOnProfile: row.shareOnProfile,
    expired: Boolean(row.expiresAt && row.expiresAt.getTime() <= Date.now()),
  };
}

export async function disconnectConnection(
  userId: string,
  provider: ConnectionProvider,
) {
  await db
    .delete(userConnectionsTable)
    .where(
      and(
        eq(userConnectionsTable.userId, BigInt(userId)),
        eq(userConnectionsTable.provider, provider),
      ),
    );
}

export async function cleanupExpiredConnectionsForUser(userId: string) {
  const rows = await db.query.userConnectionsTable.findMany({
    where: eq(userConnectionsTable.userId, BigInt(userId)),
  });

  for (const row of rows) {
    if (!row.expiresAt || row.expiresAt.getTime() > Date.now()) continue;
    if (row.provider !== "twitch" || !row.refreshToken) {
      continue;
    }

    const refreshed = await refreshTwitchToken(row.refreshToken).catch(
      () => null,
    );
    if (!refreshed) {
      continue;
    }

    await db
      .update(userConnectionsTable)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      })
      .where(
        and(
          eq(userConnectionsTable.userId, row.userId),
          eq(userConnectionsTable.provider, row.provider),
        ),
      );
  }
}

export function providerConfiguredFlags() {
  return {
    github: isGithubConfigured(),
    twitch: isTwitchConfigured(),
    steam: isSteamConfigured(),
  };
}

export function connectionsHealth() {
  return {
    ...providerConfiguredFlags(),
    spotify: isSpotifyAvailable(),
  };
}
