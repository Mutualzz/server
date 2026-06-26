import type {
  APIProfileMusic,
  APIProfileMusicSearchTrack,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { isSafeFetchUrl } from "./urlSafety";

interface ItunesTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl: string;
}

const artworkUrl = (source?: string) =>
  source?.replace("100x100bb", "600x600bb").replace("100x100", "600x600") ??
  null;

const fetchItunes = async (url: string) => {
  if (!isSafeFetchUrl(url))
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Invalid iTunes request",
    );

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok)
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "Music search is temporarily unavailable",
    );

  const data = (await response.json()) as { results?: ItunesTrack[] };
  return data.results ?? [];
};

export const searchItunesTracks = async (query: string, limit: number) => {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", query);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", String(limit));

  return fetchItunes(url.toString());
};

export const lookupItunesTrack = async (trackId: string) => {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}`;
  const results = await fetchItunes(url);
  return results[0] ?? null;
};

export const toMusicSearchTrack = (
  track: ItunesTrack,
): APIProfileMusicSearchTrack => ({
  source: "itunes",
  id: String(track.trackId),
  name: track.trackName,
  artists: track.artistName,
  image: artworkUrl(track.artworkUrl100),
  previewUrl: track.previewUrl ?? null,
  trackUrl: track.trackViewUrl,
});

export const toProfileMusicFromItunesTrack = (
  track: ItunesTrack,
): APIProfileMusic => {
  if (!track.previewUrl)
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "This track has no preview available. Pick another song or upload an MP3.",
    );

  return {
    url: track.trackViewUrl,
    title: track.trackName,
    image: artworkUrl(track.artworkUrl100),
    authorName: track.artistName,
    previewUrl: track.previewUrl,
    musicTrack: {
      source: "itunes",
      id: String(track.trackId),
    },
  };
};
