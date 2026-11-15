import { Logger } from "@mutualzz/logger";
import type { APIProfileMusic } from "@mutualzz/types";
import { CronJob } from "cron";
import { redis } from "./Redis";
import { loadUserAssetKeepSources } from "./profileAssetKeep";
import {
  cleanupOrphanedProfileAssets,
  collectProfileAssetRefs,
  type ProfileAssetSource,
} from "./profileAssets";

const logger = new Logger({ tag: "ProfileAssetPending" });

const PENDING_ZSET = "profile-assets:pending";
const PENDING_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

export type PendingProfileAssetKind = "image" | "music" | "font";

const toAssetSource = (
  kind: PendingProfileAssetKind,
  token: string,
): ProfileAssetSource => {
  if (kind === "image") return { images: [token] };
  if (kind === "font") return { pageFontFamily: `font:${token}` };
  return { profileMusic: { audioHash: token } as APIProfileMusic };
};

const isStillReferenced = (
  kind: PendingProfileAssetKind,
  token: string,
  keepSources: ProfileAssetSource[],
) =>
  keepSources.some((source) => {
    const refs = collectProfileAssetRefs(source);
    if (kind === "image") return refs.images.has(token);
    if (kind === "music") return refs.music.has(token);
    return refs.fonts.has(token);
  });

export const markProfileAssetPending = async (
  userId: string,
  kind: PendingProfileAssetKind,
  token: string,
) => {
  try {
    await redis.zadd(
      PENDING_ZSET,
      String(Date.now() + PENDING_GRACE_MS),
      `${userId}|${kind}|${token}`,
    );
  } catch (error) {
    logger.warn("Failed to mark profile asset as pending", error);
  }
};

export const sweepPendingProfileAssets = async () => {
  const dueEntries = await redis.zrangebyscore(
    PENDING_ZSET,
    "-inf",
    String(Date.now()),
    "LIMIT",
    0,
    SWEEP_BATCH_SIZE,
  );

  for (const entry of dueEntries) {
    const claimed = await redis.zrem(PENDING_ZSET, entry);
    if (!claimed) continue;

    const [userId, kind, token] = entry.split("|") as [
      string,
      PendingProfileAssetKind,
      string,
    ];
    if (!userId || !kind || !token) continue;

    try {
      const keepSources = await loadUserAssetKeepSources(userId);
      if (isStillReferenced(kind, token, keepSources)) continue;

      await cleanupOrphanedProfileAssets(
        userId,
        [toAssetSource(kind, token)],
        keepSources,
      );
    } catch (error) {
      logger.warn(`Failed to sweep pending profile asset ${entry}`, error);
    }
  }
};

export function startPendingProfileAssetSweep() {
  new CronJob(
    "*/15 * * * *",
    () => {
      void sweepPendingProfileAssets().catch((error) =>
        logger.warn("Pending profile asset sweep failed", error),
      );
    },
    null,
    true,
    "UTC",
  );
}
