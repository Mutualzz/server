export const CONNECTION_PROVIDERS = [
  "github",
  "twitch",
  "steam",
] as const;

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export function isConnectionProvider(
  value: string,
): value is ConnectionProvider {
  return (CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export interface ConnectionTokens {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: Date | null;
}

export type ConnectionProfile = {
  providerUserId: string;
  displayName: string | null;
  externalUrl: string | null;
} & ConnectionTokens;

export interface ProviderConnectionView {
  provider: ConnectionProvider;
  available: boolean;
  connected: boolean;
  displayName: string | null;
  externalUrl: string | null;
  shareOnProfile: boolean;
  expired: boolean;
}

export interface PublicConnectionView {
  provider: ConnectionProvider;
  displayName: string | null;
  externalUrl: string | null;
}

export interface OAuthStatePayload {
  userId: string;
  returnTo: string;
  provider: ConnectionProvider;
  codeVerifier?: string;
}

export interface StartOAuthResult {
  url: string;
}

export interface CompleteOAuthInput {
  provider?: ConnectionProvider;
  state: string;
  code?: string;
  iss?: string;
  openid?: Record<string, string>;
}
