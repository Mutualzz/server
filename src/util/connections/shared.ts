import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { ConnectionProvider } from "./types.ts";

export const STATE_TTL_SEC = 600;
export const STATE_PREFIX = "connections:oauth:";

export function frontendOrigin() {
  const frontend = process.env.FRONTEND_URL?.trim().replace(/\/$/, "");
  if (!frontend) {
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "FRONTEND_URL is not configured",
    );
  }
  return frontend;
}

export function toLoopbackRedirectOrigin(origin: string): string {
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

export function toLocalhostRedirectOrigin(origin: string): string {
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

export function connectionsRedirectUri() {
  const explicit = process.env.CONNECTIONS_REDIRECT_URI?.trim();
  const base = explicit
    ? explicit.replace(/\/$/, "")
    : `${frontendOrigin()}/connections/callback`;
  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "") || url.href;
  } catch {
    return base;
  }
}

export function isAllowedReturnTo(returnTo: string): boolean {
  if (returnTo === "mutualzz://connections/connected") return true;
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

export function providerEnvConfigured(
  provider: ConnectionProvider,
): boolean {
  switch (provider) {
    case "github":
      return Boolean(
        process.env.GITHUB_CLIENT_ID?.trim() &&
          process.env.GITHUB_CLIENT_SECRET?.trim(),
      );
    case "twitch":
      return Boolean(
        process.env.TWITCH_CLIENT_ID?.trim() &&
          process.env.TWITCH_CLIENT_SECRET?.trim(),
      );
    case "steam":
      return Boolean(process.env.STEAM_API_KEY?.trim());
    default:
      return false;
  }
}
