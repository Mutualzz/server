import { redis } from "./Redis";

const LRCLIB_URL = "https://lrclib.net/api/get";
const USER_AGENT = "Mutualzz (https://mutualzz.com)";
const FOUND_TTL_SEC = 7 * 24 * 60 * 60;
const NOT_FOUND_TTL_SEC = 6 * 60 * 60;
const FETCH_TIMEOUT_MS = 5000;
const BACKOFF_KEY = "lyrics:backoff";

export interface LyricLine {
  atMs: number;
  text: string;
}

export interface LyricsResult {
  instrumental: boolean;
  lines: LyricLine[] | null;
}

const TIMESTAMP_PATTERN = /\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(TIMESTAMP_PATTERN)];
    if (timestamps.length === 0) continue;

    const text = rawLine.replace(TIMESTAMP_PATTERN, "").trim();
    for (const [, minutes, seconds, fraction] of timestamps) {
      const fractionMs = fraction ? Number(fraction.padEnd(3, "0")) : 0;
      lines.push({
        atMs: Number(minutes) * 60_000 + Number(seconds) * 1000 + fractionMs,
        text,
      });
    }
  }
  return lines.sort((first, second) => first.atMs - second.atMs);
}

const cacheKey = (trackName: string, artistName: string, durationSec: number) =>
  `lyrics:v1:${artistName.trim().toLowerCase()}|${trackName.trim().toLowerCase()}|${durationSec}`;

const inFlight = new Map<string, Promise<LyricsResult | null>>();

async function fetchFromLrclib(
  trackName: string,
  artistName: string,
  durationSec: number,
): Promise<{ result: LyricsResult | null; ttlSec: number } | null> {
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName,
    duration: String(durationSec),
  });

  const response = await fetch(`${LRCLIB_URL}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 429 || response.status === 503) {
    const retryAfterSec = Number(response.headers.get("Retry-After")) || 60;
    await redis.set(BACKOFF_KEY, "1", "EX", Math.max(1, retryAfterSec));

    return null;
  }
  if (response.status === 404) {
    return {
      result: { instrumental: false, lines: null },
      ttlSec: NOT_FOUND_TTL_SEC,
    };
  }
  if (!response.ok) return null;

  const body = (await response.json()) as {
    instrumental?: boolean;
    syncedLyrics?: string | null;
  };

  const lines = body.syncedLyrics ? parseLrc(body.syncedLyrics) : [];
  return {
    result: {
      instrumental: Boolean(body.instrumental),
      lines: lines.length > 0 ? lines : null,
    },
    ttlSec: FOUND_TTL_SEC,
  };
}

export async function getLyrics(
  trackName: string,
  artistName: string,
  durationMs: number,
): Promise<LyricsResult | null> {
  const durationSec = Math.round(durationMs / 1000);
  if (durationSec < 1 || durationSec > 3600) return null;

  const key = cacheKey(trackName, artistName, durationSec);
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as LyricsResult;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    if (await redis.exists(BACKOFF_KEY)) return null;
    const fetched = await fetchFromLrclib(trackName, artistName, durationSec);
    if (!fetched) return null;
    await redis.set(key, JSON.stringify(fetched.result), "EX", fetched.ttlSec);
    return fetched.result;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}
