import {
  db,
  userActivityHistoryTable,
  userSettingsTable,
} from "@mutualzz/database";
import type {
  PresenceActivity,
  PresenceActivityAssets,
  PresenceActivityType,
} from "@mutualzz/types";
import { and, desc, eq, gt, lt, notInArray } from "drizzle-orm";
import { findLiveActivityArtUrls, isActivityArtUrl } from "./ActivityArt";
import { proxyActivityImageUrl } from "./activityImageProxy";
import { redis } from "./Redis";

export const ACTIVITY_HISTORY_MAX = 5;
export const ACTIVITY_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_HISTORY_MIN_DURATION_MS = 60_000;
export const ACTIVITY_HISTORY_MERGE_GAP_MS = 3 * 60_000;

const activeActivitiesKey = (userId: string) =>
  `activity-history:active:${userId}`;

export interface RecentActivityView {
  type: Exclude<PresenceActivityType, "custom">;
  name: string;
  applicationId?: string;
  details?: string;
  state?: string;
  url?: string;
  assets?: PresenceActivityAssets;
  startedAt: number | null;
  endedAt: number;
}

function activityIdentity(activity: {
  type: string;
  name: string;
  applicationId?: string | null;
}): string {
  return `${activity.type}|${activity.applicationId ?? ""}|${activity.name}`;
}

function historyImageUrl(
  url: string | undefined,
  liveArtUrls: Set<string>,
): string | undefined {
  if (!url) return undefined;
  if (isActivityArtUrl(url)) return liveArtUrls.has(url) ? url : undefined;
  return proxyActivityImageUrl(url);
}

function historyAssets(
  assets: PresenceActivityAssets,
  liveArtUrls: Set<string>,
): PresenceActivityAssets | null {
  const { largeImageUrl, smallImageUrl, ...textAssets } = assets;
  const largeImage = historyImageUrl(largeImageUrl, liveArtUrls);
  const smallImage = historyImageUrl(smallImageUrl, liveArtUrls);

  const result: PresenceActivityAssets = {
    ...textAssets,
    ...(largeImage ? { largeImageUrl: largeImage } : {}),
    ...(smallImage ? { smallImageUrl: smallImage } : {}),
  };
  return Object.keys(result).length > 0 ? result : null;
}

function isTrackable(activity: PresenceActivity): boolean {
  return activity.type === "playing" || activity.type === "listening";
}

function resolveStartedAt(
  activity: PresenceActivity,
  observedStart: string | null,
  now: number,
): number | null {
  const observed = observedStart ? Number(observedStart) : Number.NaN;
  if (Number.isFinite(observed) && observed <= now) return observed;

  const reported = activity.timestamps?.start;
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported <= now
  ) {
    return reported;
  }
  return null;
}

export async function recordEndedActivities(
  userId: string,
  previousActivities: PresenceActivity[],
  nextActivities: PresenceActivity[],
) {
  const previousTrackable = previousActivities.filter(isTrackable);
  const nextTrackable = nextActivities.filter(isTrackable);
  const previousIdentities = new Set(previousTrackable.map(activityIdentity));
  const nextIdentities = new Set(nextTrackable.map(activityIdentity));

  const started = nextTrackable.filter(
    (activity) => !previousIdentities.has(activityIdentity(activity)),
  );
  const ended = previousTrackable.filter(
    (activity) => !nextIdentities.has(activityIdentity(activity)),
  );
  if (started.length === 0 && ended.length === 0) return;

  const now = Date.now();
  const activeKey = activeActivitiesKey(userId);

  if (started.length > 0) {
    await redis
      .pipeline()
      .hset(
        activeKey,
        Object.fromEntries(
          started.map((activity) => [activityIdentity(activity), String(now)]),
        ),
      )
      .pexpire(activeKey, ACTIVITY_HISTORY_RETENTION_MS)
      .exec()
      .catch(() => null);
  }
  if (ended.length === 0) return;

  const endedIdentities = ended.map(activityIdentity);
  const observedStarts = await redis
    .hmget(activeKey, ...endedIdentities)
    .catch(() => endedIdentities.map(() => null));
  await redis.hdel(activeKey, ...endedIdentities).catch(() => null);

  const userIdBig = BigInt(userId);

  for (const [index, activity] of ended.entries()) {
    const identity = endedIdentities[index];
    const startedAt = resolveStartedAt(
      activity,
      observedStarts[index] ?? null,
      now,
    );

    const recentRows = await db.query.userActivityHistoryTable.findMany({
      where: and(
        eq(userActivityHistoryTable.userId, userIdBig),
        eq(userActivityHistoryTable.type, activity.type),
        eq(userActivityHistoryTable.name, activity.name),
        gt(
          userActivityHistoryTable.endedAt,
          new Date(now - ACTIVITY_HISTORY_MERGE_GAP_MS),
        ),
      ),
      orderBy: [desc(userActivityHistoryTable.endedAt)],
      limit: 5,
    });

    const continuedRow = recentRows.find(
      (row) =>
        activityIdentity({
          type: row.type,
          name: row.name,
          applicationId: row.applicationId,
        }) === identity,
    );

    if (continuedRow) {
      await db
        .update(userActivityHistoryTable)
        .set({
          endedAt: new Date(now),
          details: activity.details ?? continuedRow.details,
          state: activity.state ?? continuedRow.state,
          url: activity.url ?? continuedRow.url,
          assets: activity.assets ?? continuedRow.assets,
        })
        .where(eq(userActivityHistoryTable.id, continuedRow.id));
      continue;
    }

    if (
      startedAt != null &&
      now - startedAt < ACTIVITY_HISTORY_MIN_DURATION_MS
    ) {
      continue;
    }

    await db.insert(userActivityHistoryTable).values({
      userId: userIdBig,
      type: activity.type,
      name: activity.name,
      applicationId: activity.applicationId ?? null,
      details: activity.details ?? null,
      state: activity.state ?? null,
      url: activity.url ?? null,
      assets: activity.assets ?? null,
      startedAt: startedAt != null ? new Date(startedAt) : null,
      endedAt: new Date(now),
    });
  }

  await pruneActivityHistory(userId);
}

export async function pruneActivityHistory(userId: string) {
  const cutoff = new Date(Date.now() - ACTIVITY_HISTORY_RETENTION_MS);
  const userIdBig = BigInt(userId);

  await db
    .delete(userActivityHistoryTable)
    .where(
      and(
        eq(userActivityHistoryTable.userId, userIdBig),
        lt(userActivityHistoryTable.endedAt, cutoff),
      ),
    );

  const keep = await db.query.userActivityHistoryTable.findMany({
    where: eq(userActivityHistoryTable.userId, userIdBig),
    orderBy: [desc(userActivityHistoryTable.endedAt)],
    columns: { id: true },
    limit: ACTIVITY_HISTORY_MAX,
  });

  if (keep.length === 0) {
    await db
      .delete(userActivityHistoryTable)
      .where(eq(userActivityHistoryTable.userId, userIdBig));
    return;
  }

  const keepIds = keep.map((row) => row.id);
  await db
    .delete(userActivityHistoryTable)
    .where(
      and(
        eq(userActivityHistoryTable.userId, userIdBig),
        notInArray(userActivityHistoryTable.id, keepIds),
      ),
    );
}

export async function clearActivityHistory(userId: string) {
  await db
    .delete(userActivityHistoryTable)
    .where(eq(userActivityHistoryTable.userId, BigInt(userId)));
}

export async function listRecentActivities(
  userId: string,
  viewerId?: string | null,
): Promise<RecentActivityView[]> {
  const isSelf = viewerId != null && viewerId === userId;
  if (!isSelf) {
    const settings = await db.query.userSettingsTable
      .findFirst({
        where: eq(userSettingsTable.userId, BigInt(userId)),
        columns: { shareRecentActivity: true },
      })
      .catch(() => null);

    if (settings && !settings.shareRecentActivity) {
      return [];
    }
  }

  const cutoff = new Date(Date.now() - ACTIVITY_HISTORY_RETENTION_MS);
  const rows = await db.query.userActivityHistoryTable.findMany({
    where: and(
      eq(userActivityHistoryTable.userId, BigInt(userId)),
      gt(userActivityHistoryTable.endedAt, cutoff),
    ),
    orderBy: [desc(userActivityHistoryTable.endedAt)],
    limit: ACTIVITY_HISTORY_MAX * 4,
  });

  const liveArtUrls = await findLiveActivityArtUrls(
    rows.flatMap((row) => [
      row.assets?.largeImageUrl,
      row.assets?.smallImageUrl,
    ]),
  );

  const seen = new Set<string>();
  const activities: RecentActivityView[] = [];

  for (const row of rows) {
    if (row.type !== "playing" && row.type !== "listening") continue;
    const key = activityIdentity({
      type: row.type,
      name: row.name,
      applicationId: row.applicationId,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    const assets = row.assets ? historyAssets(row.assets, liveArtUrls) : null;
    activities.push({
      type: row.type,
      name: row.name,
      ...(row.applicationId ? { applicationId: row.applicationId } : {}),
      ...(row.details ? { details: row.details } : {}),
      ...(row.state ? { state: row.state } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(assets ? { assets } : {}),
      startedAt: row.startedAt ? row.startedAt.getTime() : null,
      endedAt: row.endedAt.getTime(),
    });
    if (activities.length >= ACTIVITY_HISTORY_MAX) break;
  }

  return activities;
}
