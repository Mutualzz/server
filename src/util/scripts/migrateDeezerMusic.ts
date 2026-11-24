import "dotenv/config";

import {
  closeDatabase,
  db,
  startDatabase,
  userProfilesTable,
  userProfileVersionsTable,
} from "@mutualzz/database";
import type {
  APIMobileProfileBlock,
  APIProfileBlock,
  APIProfileMusic,
  APIProfileMusicSearchTrack,
  APIUserProfileSnapshot,
} from "@mutualzz/types";
import { eq } from "drizzle-orm";
import {
  searchItunesTracks,
  toMusicSearchTrack,
  toProfileMusicFromItunesTrack,
} from "../itunesMusic";

type ItunesTrack = Awaited<ReturnType<typeof searchItunesTracks>>[number];

interface LegacyTrackRef {
  source: string;
  id: string;
}

interface LegacySearchTrack {
  source: string;
  id: string;
  name: string;
  artists: string;
}

const ITUNES_DELAY_MS = 3_500;
const SEARCH_LIMIT = 10;
const apply = process.argv.includes("--apply");

const matchCache = new Map<string, ItunesTrack | null>();
const stats = { matched: 0, removed: 0, profiles: 0, versions: 0 };

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s-\s.*$/, " ")
    .replace(/feat\..*$|ft\..*$/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const isSameSong = (candidate: ItunesTrack, title: string, artist: string) => {
  const candidateTitle = normalize(candidate.trackName);
  const candidateArtist = normalize(candidate.artistName);
  const wantedTitle = normalize(title);
  const wantedArtist = normalize(artist);
  const titleMatches = candidateTitle === wantedTitle;
  const artistMatches =
    !wantedArtist ||
    candidateArtist.includes(wantedArtist) ||
    wantedArtist.includes(candidateArtist);
  return titleMatches && artistMatches && !!candidate.previewUrl;
};

const findItunesMatch = async (
  deezerId: string,
  title: string,
  artist: string,
): Promise<ItunesTrack | null> => {
  if (matchCache.has(deezerId)) return matchCache.get(deezerId) ?? null;
  await sleep(ITUNES_DELAY_MS);
  const results = await searchItunesTracks(
    `${title} ${artist}`.trim(),
    SEARCH_LIMIT,
  ).catch((error) => {
    console.warn(`iTunes search failed for "${title}" by ${artist}`, error);
    return [];
  });
  const match =
    results.find((candidate) => isSameSong(candidate, title, artist)) ?? null;
  matchCache.set(deezerId, match);
  console.log(
    match
      ? `  match: "${title}" by ${artist} -> iTunes ${match.trackId} "${match.trackName}" by ${match.artistName}`
      : `  no match: "${title}" by ${artist} (will be removed)`,
  );
  return match;
};

const isDeezerRef = (track: LegacyTrackRef | null | undefined) =>
  track?.source === "deezer";

const migrateProfileMusic = async (
  music: APIProfileMusic | null | undefined,
): Promise<{ music: APIProfileMusic | null | undefined; changed: boolean }> => {
  const reference = music?.musicTrack as LegacyTrackRef | null | undefined;
  if (!music || !isDeezerRef(reference) || !reference) {
    return { music, changed: false };
  }
  const match = await findItunesMatch(
    reference.id,
    music.title ?? "",
    music.authorName ?? "",
  );
  if (!match) {
    stats.removed += 1;
    return { music: null, changed: true };
  }
  stats.matched += 1;
  return { music: toProfileMusicFromItunesTrack(match), changed: true };
};

const migrateBlocks = async <
  Block extends APIProfileBlock | APIMobileProfileBlock,
>(
  blocks: Block[] | null | undefined,
  copyTopLevelFields: boolean,
): Promise<{ blocks: Block[] | null | undefined; changed: boolean }> => {
  if (!blocks) return { blocks, changed: false };
  let changed = false;
  const next: Block[] = [];
  for (const block of blocks) {
    const legacyTrack =
      block.type === "music"
        ? (block.track as LegacySearchTrack | null | undefined)
        : null;
    if (block.type !== "music" || !legacyTrack || !isDeezerRef(legacyTrack)) {
      next.push(block);
      continue;
    }
    changed = true;
    const match = await findItunesMatch(
      legacyTrack.id,
      legacyTrack.name,
      legacyTrack.artists,
    );
    if (!match) {
      stats.removed += 1;
      next.push({
        ...block,
        track: null,
        previewUrl: null,
        trackUrl: null,
      });
      continue;
    }
    stats.matched += 1;
    const track: APIProfileMusicSearchTrack = toMusicSearchTrack(match);
    next.push({
      ...block,
      track,
      title: null,
      artists: null,
      image: null,
      audioHash: null,
      previewUrl: copyTopLevelFields ? (track.previewUrl ?? null) : null,
      trackUrl: copyTopLevelFields ? track.trackUrl : null,
    });
  }
  return { blocks: next, changed };
};

const migrateProfiles = async () => {
  const profiles = await db.select().from(userProfilesTable);
  for (const profile of profiles) {
    const music = await migrateProfileMusic(profile.profileMusic);
    const blocks = await migrateBlocks(profile.blocks, false);
    const mobileBlocks = await migrateBlocks(profile.mobileBlocks, true);
    if (!music.changed && !blocks.changed && !mobileBlocks.changed) continue;
    stats.profiles += 1;
    console.log(`profile ${profile.userId}: needs migration`);
    if (!apply) continue;
    await db
      .update(userProfilesTable)
      .set({
        profileMusic: music.music ?? null,
        blocks: blocks.blocks ?? [],
        mobileBlocks: mobileBlocks.blocks ?? [],
      })
      .where(eq(userProfilesTable.userId, profile.userId));
  }
};

const migrateVersions = async () => {
  const versions = await db.select().from(userProfileVersionsTable);
  for (const version of versions) {
    const snapshot = version.snapshot as APIUserProfileSnapshot;
    const music = await migrateProfileMusic(snapshot.profileMusic);
    const blocks = await migrateBlocks(snapshot.blocks, false);
    const mobileBlocks = await migrateBlocks(snapshot.mobileBlocks, true);
    if (!music.changed && !blocks.changed && !mobileBlocks.changed) continue;
    stats.versions += 1;
    console.log(`version ${version.id}: needs migration`);
    if (!apply) continue;
    await db
      .update(userProfileVersionsTable)
      .set({
        snapshot: {
          ...snapshot,
          profileMusic: music.music ?? null,
          blocks: blocks.blocks ?? [],
          mobileBlocks: mobileBlocks.blocks ?? [],
        },
      })
      .where(eq(userProfileVersionsTable.id, version.id));
  }
};

async function main() {
  await startDatabase();
  console.log(apply ? "Applying changes." : "Dry run. Pass --apply to write.");
  await migrateProfiles();
  await migrateVersions();
  console.log(
    `Done. Profiles: ${stats.profiles}, versions: ${stats.versions}, tracks matched: ${stats.matched}, tracks removed: ${stats.removed}.`,
  );
}

main()
  .catch((error) => {
    console.error("Deezer music migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
