import type {
  APIProfileIntroMusic,
  APIProfileMusicSearchTrack,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { isSafeFetchUrl } from "./urlSafety";

interface DeezerSearchResult {
  id: number;
  title: string;
  preview?: string;
  link: string;
  artist?: { name?: string };
  album?: {
    cover_big?: string;
    cover_xl?: string;
  };
}

interface DeezerSearchResponse {
  data?: DeezerSearchResult[];
}

const fetchDeezer = async (url: string) => {
  if (!isSafeFetchUrl(url)) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid Deezer request",
    );
  }

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "Music search is temporarily unavailable",
    );
  }

  const data = (await response.json()) as DeezerSearchResponse;
  return data.data ?? [];
};

export const searchDeezerTracks = async (query: string, limit: number) => {
  const url = new URL("https://api.deezer.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  return fetchDeezer(url.toString());
};

export const lookupDeezerTrack = async (trackId: string) => {
  const url = `https://api.deezer.com/track/${encodeURIComponent(trackId)}`;
  if (!isSafeFetchUrl(url)) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid Deezer request",
    );
  }

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) return null;
  const track = (await response.json()) as DeezerSearchResult & {
    error?: unknown;
  };
  if ((track as { error?: unknown }).error) return null;
  return track;
};

export const toDeezerMusicSearchTrack = (
  track: DeezerSearchResult,
): APIProfileMusicSearchTrack => ({
  source: "deezer",
  id: String(track.id),
  name: track.title,
  artists: track.artist?.name ?? "",
  image: track.album?.cover_xl ?? track.album?.cover_big ?? null,
  previewUrl: track.preview ?? null,
  trackUrl: track.link,
});

export const toIntroMusicFromDeezerTrack = (
  track: DeezerSearchResult,
): APIProfileIntroMusic => {
  if (!track.preview) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "This track has no preview available. Pick another song or upload an MP3.",
    );
  }

  return {
    url: track.link,
    title: track.title,
    image: track.album?.cover_xl ?? track.album?.cover_big ?? null,
    authorName: track.artist?.name ?? null,
    previewUrl: track.preview,
    musicTrack: {
      source: "deezer",
      id: String(track.id),
    },
  };
};
