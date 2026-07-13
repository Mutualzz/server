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

export type ConnectionTokens = {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: Date | null;
};

export type ConnectionProfile = {
  providerUserId: string;
  displayName: string | null;
  externalUrl: string | null;
} & ConnectionTokens;

export type ProviderConnectionView = {
  provider: ConnectionProvider;
  available: boolean;
  connected: boolean;
  displayName: string | null;
  externalUrl: string | null;
  shareOnProfile: boolean;
  expired: boolean;
};

export type PublicConnectionView = {
  provider: ConnectionProvider;
  displayName: string | null;
  externalUrl: string | null;
};

export type OAuthStatePayload = {
  userId: string;
  returnTo: string;
  provider: ConnectionProvider;
  codeVerifier?: string;
};

export type StartOAuthResult = {
  url: string;
};

export type CompleteOAuthInput = {
  provider?: ConnectionProvider;
  state: string;
  code?: string;
  iss?: string;
  openid?: Record<string, string>;
};
