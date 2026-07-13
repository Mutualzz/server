import type {
  APIMobileProfileBlock,
  APIProfileBlock,
  APIProfileMusic,
  APIProfileMusicSearchTrack,
  APIUserProfile,
} from "@mutualzz/types";
import { lookupDeezerTrack } from "./deezerMusic";
import { lookupItunesTrack } from "./itunesMusic";

type MusicSource = "itunes" | "deezer";

type PreviewCacheEntry = {
  url: string;
  expiresAt: number;
};

const previewCache = new Map<string, PreviewCacheEntry>();
const DEEZER_CACHE_SKEW_MS = 60_000;
const ITUNES_CACHE_TTL_MS = 24 * 60 * 60_000;
const DEEZER_FALLBACK_TTL_MS = 10 * 60_000;

const cacheKey = (source: MusicSource, id: string) => `${source}:${id}`;

const deezerExpiryMs = (previewUrl: string) => {
  try {
    const hdnea = new URL(previewUrl).searchParams.get("hdnea");
    const match = hdnea?.match(/(?:^|~)exp=(\d+)/);
    if (!match?.[1]) return Date.now() + DEEZER_FALLBACK_TTL_MS;
    return Number(match[1]) * 1000 - DEEZER_CACHE_SKEW_MS;
  } catch {
    return Date.now() + DEEZER_FALLBACK_TTL_MS;
  }
};

export const resolveSearchTrackPreviewUrl = async (
  source: MusicSource,
  id: string,
): Promise<string | null> => {
  const key = cacheKey(source, id);
  const cached = previewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  if (source === "deezer") {
    const track = await lookupDeezerTrack(id).catch(() => null);
    const url = track?.preview ?? null;
    if (!url) {
      previewCache.delete(key);
      return null;
    }
    previewCache.set(key, { url, expiresAt: deezerExpiryMs(url) });
    return url;
  }

  const track = await lookupItunesTrack(id).catch(() => null);
  const url = track?.previewUrl ?? null;
  if (!url) {
    previewCache.delete(key);
    return null;
  }
  previewCache.set(key, {
    url,
    expiresAt: Date.now() + ITUNES_CACHE_TTL_MS,
  });
  return url;
};

const hydrateSearchTrack = async (
  track: APIProfileMusicSearchTrack | null | undefined,
): Promise<APIProfileMusicSearchTrack | null | undefined> => {
  if (!track) return track;
  const previewUrl = await resolveSearchTrackPreviewUrl(track.source, track.id);
  if (!previewUrl || previewUrl === track.previewUrl) return track;
  return { ...track, previewUrl };
};

const hydrateProfileMusic = async (
  music: APIProfileMusic | null | undefined,
): Promise<APIProfileMusic | null | undefined> => {
  if (!music?.musicTrack) return music;
  const previewUrl = await resolveSearchTrackPreviewUrl(
    music.musicTrack.source,
    music.musicTrack.id,
  );
  if (!previewUrl || previewUrl === music.previewUrl) return music;
  return { ...music, previewUrl };
};

const hydrateMusicBlock = async <
  T extends APIProfileBlock | APIMobileProfileBlock,
>(
  block: T,
): Promise<T> => {
  if (block.type !== "music") return block;
  const track = await hydrateSearchTrack(block.track);
  if (track === block.track) return block;
  return { ...block, track: track ?? null };
};

export const hydrateUserProfileMusicPreviews = async (
  profile: APIUserProfile,
): Promise<APIUserProfile> => {
  const [profileMusic, blocks, mobileBlocks] = await Promise.all([
    hydrateProfileMusic(profile.profileMusic),
    Promise.all(profile.blocks.map((block) => hydrateMusicBlock(block))),
    Promise.all(profile.mobileBlocks.map((block) => hydrateMusicBlock(block))),
  ]);

  return {
    ...profile,
    profileMusic: profileMusic ?? null,
    blocks,
    mobileBlocks,
  };
};
