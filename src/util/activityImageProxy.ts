import crypto from "node:crypto";
import type { PresenceActivityAssets } from "@mutualzz/types";

// Activity images (RPC large/small image URLs, Spotify art) are served through
// the CDN so viewers never load third-party URLs directly (which would leak
// their IP to whoever runs that server). URLs are HMAC-signed so the CDN only
// fetches URLs that went through the gateway sanitizer, not arbitrary ones.

const PATH_PREFIX = "/external/";

function cdnBase() {
  return process.env.CDN_URL?.trim().replace(/\/+$/, "") || null;
}

function sign(url: string) {
  return crypto
    .createHmac("sha256", process.env.SECRET as string)
    .update(`activity-image:${url}`)
    .digest("base64url")
    .slice(0, 32);
}

export function verifyExternalImage(signature: string, encoded: string) {
  let url: string;
  try {
    url = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = Buffer.from(sign(url));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;

  return url;
}

function parseProxiedUrl(raw: string) {
  const base = cdnBase();
  if (!base || !raw.startsWith(base + PATH_PREFIX)) return null;

  const [signature, encoded] = raw
    .slice(base.length + PATH_PREFIX.length)
    .split(/[/?]/);
  if (!signature || !encoded) return null;

  return verifyExternalImage(signature, encoded) ? raw : null;
}

export function proxyActivityImageUrl(url: string | undefined) {
  if (!url) return undefined;

  // Already ours (a client echoing back a presence it received)
  if (parseProxiedUrl(url)) return url;

  const base = cdnBase();
  if (!base) return undefined;

  const encoded = Buffer.from(url, "utf8").toString("base64url");
  return `${base}${PATH_PREFIX}${sign(url)}/${encoded}`;
}

export function isProxiedActivityImageUrl(url: unknown): url is string {
  return typeof url === "string" && parseProxiedUrl(url) !== null;
}

export function proxyActivityAssets(
  assets: PresenceActivityAssets,
): PresenceActivityAssets {
  const largeImageUrl = proxyActivityImageUrl(assets.largeImageUrl);
  const smallImageUrl = proxyActivityImageUrl(assets.smallImageUrl);

  const { largeImageUrl: _l, smallImageUrl: _s, ...rest } = assets;
  return {
    ...rest,
    ...(largeImageUrl ? { largeImageUrl } : {}),
    ...(smallImageUrl ? { smallImageUrl } : {}),
  };
}
