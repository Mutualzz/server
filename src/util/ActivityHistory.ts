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

export const ACTIVITY_HISTORY_MAX = 5;
export const ACTIVITY_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_HISTORY_MIN_DURATION_MS = 60_000;
export const ACTIVITY_HISTORY_DEDUPE_MS = ACTIVITY_HISTORY_RETENTION_MS;

export type RecentActivityView = {
  type: Exclude<PresenceActivityType, "custom">;
  name: string;
  applicationId?: string;
  details?: string;
  state?: string;
  url?: string;
  assets?: PresenceActivityAssets;
  startedAt: number | null;
  endedAt: number;
};

function activityIdentity(activity: {
  type: string;
  name: string;
  applicationId?: string | null;
}): string {
  return `${activity.type}|${activity.applicationId ?? ""}|${activity.name}`;
}

function isTrackable(activity: PresenceActivity): boolean {
  return activity.type === "playing" || activity.type === "listening";
}

export async function recordEndedActivities(
  userId: string,
  previousActivities: PresenceActivity[],
  nextActivities: PresenceActivity[],
) {
  const prev = previousActivities.filter(isTrackable);
  if (prev.length === 0) return;

  const nextKeys = new Set(
    nextActivities.filter(isTrackable).map(activityIdentity),
  );
  const ended = prev.filter(
    (activity) => !nextKeys.has(activityIdentity(activity)),
  );
  if (ended.length === 0) return;

  const now = Date.now();
  const userIdBig = BigInt(userId);

  for (const activity of ended) {
    const startedAt = activity.timestamps?.start;
    if (
      typeof startedAt === "number" &&
      Number.isFinite(startedAt) &&
      now - startedAt < ACTIVITY_HISTORY_MIN_DURATION_MS
    ) {
      continue;
    }

    const identity = activityIdentity(activity);
    const recentRows = await db.query.userActivityHistoryTable.findMany({
      where: and(
        eq(userActivityHistoryTable.userId, userIdBig),
        eq(userActivityHistoryTable.type, activity.type),
        eq(userActivityHistoryTable.name, activity.name),
        gt(
          userActivityHistoryTable.endedAt,
          new Date(now - ACTIVITY_HISTORY_DEDUPE_MS),
        ),
      ),
      orderBy: [desc(userActivityHistoryTable.endedAt)],
      limit: 5,
    });

    const match = recentRows.find(
      (row) =>
        activityIdentity({
          type: row.type,
          name: row.name,
          applicationId: row.applicationId,
        }) === identity,
    );

    if (match) {
      const nextStartedAt =
        typeof startedAt === "number" && Number.isFinite(startedAt)
          ? startedAt
          : null;
      const existingStartedAt = match.startedAt?.getTime() ?? null;
      const mergedStartedAt =
        existingStartedAt != null && nextStartedAt != null
          ? Math.min(existingStartedAt, nextStartedAt)
          : (existingStartedAt ?? nextStartedAt);

      await db
        .update(userActivityHistoryTable)
        .set({
          endedAt: new Date(now),
          details: activity.details ?? match.details,
          state: activity.state ?? match.state,
          url: activity.url ?? match.url,
          assets: activity.assets ?? match.assets,
          startedAt:
            mergedStartedAt != null ? new Date(mergedStartedAt) : null,
        })
        .where(eq(userActivityHistoryTable.id, match.id));
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
      startedAt:
        typeof startedAt === "number" && Number.isFinite(startedAt)
          ? new Date(startedAt)
          : null,
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

    if (settings && settings.shareRecentActivity === false) {
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
    activities.push({
      type: row.type,
      name: row.name,
      ...(row.applicationId ? { applicationId: row.applicationId } : {}),
      ...(row.details ? { details: row.details } : {}),
      ...(row.state ? { state: row.state } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(row.assets ? { assets: row.assets } : {}),
      startedAt: row.startedAt ? row.startedAt.getTime() : null,
      endedAt: row.endedAt.getTime(),
    });
    if (activities.length >= ACTIVITY_HISTORY_MAX) break;
  }

  return activities;
}
