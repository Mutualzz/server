const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

const isPrivateIPv4 = (host: string) => {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255))
    return false;

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
};

const isPrivateIPv6 = (host: string) => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe80")) return true;
  return false;
};

export const isSafeFetchUrl = (urlString: string) => {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return false;
  }

  if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) return false;

  return true;
};
