import type { WebSocket } from "../util/WebSocket";
import { PresenceStore } from "./Presence.store.ts";
import { Send } from "../util/Send";
import {
  GatewayCloseCodes,
  type CustomStatusSchedule,
  type CustomStatusSnapshot,
  type PresenceActivity,
  type PresenceActivityEmoji,
  type PresencePayload,
  type PresenceSchedule,
  type PresenceStatus,
} from "@mutualzz/types";
import {
  sanitizePresence,
  sanitizeActivityEmoji,
  MAX_ACTIVITIES,
  MAX_STR,
} from "./Presence.validator.ts";
import { logger } from "../Logger";
import { PresenceBucket } from "./Presence.bucket.ts";
import { resyncMemberListWindows } from "../util/Calculations";
import { emitEvent, redis } from "@mutualzz/util";

type ResyncKey = string;

const SCHEDULE_KEY = (userId: string) => `presence:schedule:${userId}`;
const MANUAL_KEY = (userId: string) => `presence:manual:${userId}`;

const SCHEDULE_ZSET = `presence:schedules`; // member=userId score=until(ms)
const SCHEDULE_LOCK = `presence:schedule:worker-lock`;

const CUSTOM_STATUS_SCHEDULE_KEY = (userId: string) =>
  `presence:custom-status:${userId}`;
const CUSTOM_STATUS_SCHEDULE_ZSET = `presence:custom-status-schedules`;

function buildCustomActivity(
  text: string,
  emoji?: PresenceActivityEmoji | null,
): PresenceActivity {
  const trimmed = text.trim();

  return {
    type: "custom",
    name: "",
    state: trimmed,
    ...(emoji ? { emoji } : {}),
  };
}

function normalizeCustomStatusSnapshot(
  raw: unknown,
): CustomStatusSnapshot | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? { text, emoji: null } : null;
  }

  if (typeof raw !== "object") return null;

  const assumed = raw as CustomStatusSnapshot;
  const text =
    typeof assumed.text === "string" ? assumed.text.trim() || null : null;
  const emoji = sanitizeActivityEmoji(assumed.emoji) ?? null;

  if (!text && !emoji) return null;

  return { text, emoji };
}

function getCustomStatusSnapshot(
  activities: PresenceActivity[] | undefined,
): CustomStatusSnapshot | null {
  const custom = activities?.find((activity) => activity.type === "custom");
  if (!custom) return null;

  const text = custom.state?.trim() || custom.name?.trim() || null;
  const emoji = sanitizeActivityEmoji(custom.emoji) ?? null;

  if (!text && !emoji) return null;

  return { text, emoji };
}

function applyCustomStatus(
  activities: PresenceActivity[],
  text: string,
  emoji?: PresenceActivityEmoji | null,
): PresenceActivity[] {
  const withoutCustom = activities.filter(
    (activity) => activity.type !== "custom",
  );
  const trimmed = text.trim();

  if (!trimmed && !emoji) return withoutCustom;

  return [buildCustomActivity(trimmed, emoji), ...withoutCustom].slice(
    0,
    MAX_ACTIVITIES,
  );
}

function applyCustomStatusSnapshot(
  activities: PresenceActivity[],
  snapshot: CustomStatusSnapshot | null,
): PresenceActivity[] {
  if (!snapshot) return removeCustomStatus(activities);

  return applyCustomStatus(
    activities,
    snapshot.text ?? "",
    snapshot.emoji ?? null,
  );
}

function removeCustomStatus(
  activities: PresenceActivity[],
): PresenceActivity[] {
  return activities.filter((activity) => activity.type !== "custom");
}

export class PresenceService {
  private static store = new PresenceStore();
  private static started = false;

  private static resyncTimers = new Map<ResyncKey, NodeJS.Timeout>();

  private static scheduleLoopStarted = false;

  static startBackgroundWorkers() {
    this.ensureGcLoop();
    this.ensureScheduleLoop();
  }

  static async onSocketAuthenticated(ws: WebSocket) {
    this.startBackgroundWorkers();

    PresenceBucket.add(ws);

    ws.memberListSubs = ws.memberListSubs ?? new Map();
    ws.presences = ws.presences ?? new Map();

    if (!ws.userId) return;

    await this.store.warmFromRedis(ws.userId).catch(() => null);

    const scheduled = await this.getSchedule(ws.userId).catch(() => null);
    const customScheduled = await this.getCustomStatusSchedule(ws.userId).catch(
      () => null,
    );
    const manual = await this.getManualStatus(ws.userId).catch(() => null);

    let existing = await this.store.get(ws.userId);
    if (existing?.status === "offline") existing = null;

    let presence =
      existing ??
      this.store.upsert(ws.userId, {
        status: "online",
        activities: [],
        device: "web",
      });

    if (scheduled && scheduled.until > Date.now())
      presence = this.store.upsert(ws.userId, {
        ...(presence ?? { activities: [], device: "web" }),
        status: scheduled.status,
      });
    else if (scheduled)
      presence = await this.expireSchedule(ws.userId, scheduled);
    else if (manual)
      presence = this.store.upsert(ws.userId, {
        ...(presence ?? { activities: [], device: "web" }),
        status: manual,
      });

    if (customScheduled && customScheduled.until > Date.now())
      presence = this.store.upsert(ws.userId, {
        ...(presence ?? { activities: [], device: "web" }),
        activities: applyCustomStatus(
          presence?.activities ?? [],
          customScheduled.text,
          customScheduled.emoji,
        ),
      });
    else if (customScheduled)
      presence = await this.expireCustomStatusSchedule(
        ws.userId,
        customScheduled,
      );

    this.store.touch(ws.userId);

    await Send(ws, {
      op: "Dispatch",
      t: "PresenceUpdate",
      d: { userId: ws.userId, presence },
      s: ws.sequence++,
    }).catch(() => null);

    await this.broadcast(ws.userId, presence);
    await this.notifyScheduleChanged(
      ws.userId,
      scheduled && scheduled.until > Date.now() ? scheduled : null,
    );
    await this.notifyCustomStatusScheduleChanged(
      ws.userId,
      customScheduled && customScheduled.until > Date.now()
        ? customScheduled
        : null,
    );
  }

  static onSocketClose(ws: WebSocket) {
    PresenceBucket.remove(ws);

    for (const [key, timer] of this.resyncTimers) {
      if (key.startsWith(`${ws.sessionId}:`)) {
        clearTimeout(timer);
        this.resyncTimers.delete(key);
      }
    }
  }

  static async get(userId: string) {
    return this.store.get(userId);
  }

  static async getScheduleForUser(
    userId: string,
  ): Promise<PresenceSchedule | null> {
    const schedule = await this.getSchedule(userId).catch(() => null);
    if (!schedule || schedule.until <= Date.now()) return null;
    return schedule;
  }

  static async getCustomStatusScheduleForUser(
    userId: string,
  ): Promise<CustomStatusSchedule | null> {
    const schedule = await this.getCustomStatusSchedule(userId).catch(
      () => null,
    );
    if (!schedule || schedule.until <= Date.now()) return null;
    return schedule;
  }

  static async handleUpdate(ws: WebSocket, rawPresence: any) {
    this.ensureGcLoop();
    this.ensureScheduleLoop();

    if (!ws.userId) {
      ws.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
      return;
    }

    const persist = Boolean(rawPresence?.persist);
    const presenceInput = rawPresence?.presence ?? rawPresence;

    const clean = sanitizePresence(presenceInput);

    if (persist && clean.status === "offline") return;

    const scheduled = await this.getSchedule(ws.userId).catch(() => null);
    if (scheduled && scheduled.until > Date.now())
      clean.status = scheduled.status;
    else if (persist)
      await this.setManualStatus(ws.userId, clean.status).catch(() => null);

    const customScheduled = await this.getCustomStatusSchedule(ws.userId).catch(
      () => null,
    );
    if (customScheduled && customScheduled.until > Date.now())
      clean.activities = applyCustomStatus(
        clean.activities,
        customScheduled.text,
        customScheduled.emoji,
      );

    const presence = this.store.upsert(ws.userId, clean);
    await this.broadcast(ws.userId, presence);
  }

  static async onDisconnect(userId?: string) {
    if (!userId) return;
    this.ensureGcLoop();
    this.ensureScheduleLoop();

    setTimeout(async () => {
      if (PresenceBucket.hasAnyAuthenticatedSocket(userId)) return;

      const presence = this.store.setOffline(userId);
      await this.broadcast(userId, presence);
    }, 250).unref?.();
  }

  static async setScheduledStatus(
    userId: string,
    opts: { status: PresenceStatus; durationMs: number },
  ) {
    this.ensureScheduleLoop();

    const now = Date.now();

    await this.store.warmFromRedis(userId).catch(() => null);
    const scheduled = await this.getSchedule(userId).catch(() => null);
    const manual = await this.getManualStatus(userId).catch(() => null);
    const current = await this.store.get(userId);

    const revertTo: PresenceStatus =
      manual ??
      (scheduled && scheduled.until > Date.now() ? scheduled.revertTo : null) ??
      (current?.status && current.status !== "offline"
        ? current.status
        : "online");

    const schedule: PresenceSchedule = {
      status: opts.status,
      revertTo,
      until: now + Math.max(0, opts.durationMs),
    };

    await this.setSchedule(userId, schedule);

    const applied = this.store.upsert(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: schedule.status,
    });

    await this.broadcast(userId, applied);
    await this.notifyScheduleChanged(userId, schedule);
  }

  static async clearScheduledStatus(userId: string) {
    this.ensureScheduleLoop();

    const existing = await this.getSchedule(userId).catch(() => null);
    await this.clearSchedule(userId);

    if (existing) {
      await this.store.warmFromRedis(userId).catch(() => null);
      const current = await this.store.get(userId);

      const reverted = this.store.upsert(userId, {
        ...(current ?? { activities: [], device: "web" }),
        status: existing.revertTo ?? "online",
      });

      await this.broadcast(userId, reverted);
    }

    await this.notifyScheduleChanged(userId, null);
  }

  static async setScheduledCustomStatus(
    userId: string,
    opts: {
      text: string;
      emoji?: PresenceActivityEmoji | null;
      durationMs: number;
    },
  ) {
    this.ensureScheduleLoop();

    const now = Date.now();
    const text = opts.text.trim().slice(0, MAX_STR);
    const emoji = sanitizeActivityEmoji(opts.emoji) ?? null;

    if (!text && !emoji) return;

    await this.store.warmFromRedis(userId).catch(() => null);
    const current = await this.store.get(userId);
    const existingCustomSchedule = await this.getCustomStatusSchedule(
      userId,
    ).catch(() => null);

    const revertTo =
      existingCustomSchedule && existingCustomSchedule.until > Date.now()
        ? normalizeCustomStatusSnapshot(existingCustomSchedule.revertTo)
        : getCustomStatusSnapshot(current?.activities);

    const schedule: CustomStatusSchedule = {
      text,
      emoji,
      revertTo,
      until: now + Math.max(0, opts.durationMs),
    };

    await this.setCustomStatusSchedule(userId, schedule);

    const applied = this.store.upsert(userId, {
      ...(current ?? { activities: [], device: "web", status: "online" }),
      activities: applyCustomStatus(current?.activities ?? [], text, emoji),
    });

    await this.broadcast(userId, applied);
    await this.notifyCustomStatusScheduleChanged(userId, schedule);
  }

  static async clearScheduledCustomStatus(userId: string) {
    this.ensureScheduleLoop();

    const existing = await this.getCustomStatusSchedule(userId).catch(
      () => null,
    );
    await this.clearCustomStatusSchedule(userId);

    if (existing) {
      await this.store.warmFromRedis(userId).catch(() => null);
      const current = await this.store.get(userId);
      const activities = applyCustomStatusSnapshot(
        current?.activities ?? [],
        normalizeCustomStatusSnapshot(existing.revertTo),
      );

      const reverted = this.store.upsert(userId, {
        ...(current ?? { activities: [], device: "web", status: "online" }),
        activities,
      });

      await this.broadcast(userId, reverted);
    }

    await this.notifyCustomStatusScheduleChanged(userId, null);
  }

  private static async getManualStatus(
    userId: string,
  ): Promise<PresenceStatus | null> {
    const raw = await redis.get(MANUAL_KEY(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { status?: PresenceStatus };
      return parsed?.status ?? null;
    } catch {
      return null;
    }
  }

  private static async setManualStatus(userId: string, status: PresenceStatus) {
    if (status === "offline") return;
    await redis.set(MANUAL_KEY(userId), JSON.stringify({ status }));
  }

  private static ensureGcLoop() {
    if (this.started) return;

    this.started = true;

    setInterval(() => {
      for (const ws of PresenceBucket.authenticatedSockets())
        if (ws.userId) this.store.touch(ws.userId);

      this.store.gc();
    }, 30_000).unref?.();
  }

  private static scheduleResyncForTargets(
    userId: string,
    targets: WebSocket[],
  ) {
    for (const socket of targets) {
      const presencesBySubKey = socket.presences;
      if (!presencesBySubKey || presencesBySubKey.size === 0) continue;

      for (const [subKey, visibleUserIds] of presencesBySubKey) {
        if (!visibleUserIds?.has(userId)) continue;

        const resyncKey: ResyncKey = `${socket.sessionId}:${subKey}`;

        const existingTimer = this.resyncTimers.get(resyncKey);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
          this.resyncTimers.delete(resyncKey);
          try {
            await resyncMemberListWindows.call(socket, subKey);
          } catch (error) {
            logger.debug("[Presence] resync failed:", error);
          }
        }, 250);

        this.resyncTimers.set(resyncKey, timer);
      }
    }
  }

  private static async broadcast(userId: string, presence: PresencePayload) {
    const seenBy = PresenceBucket.socketsSeeingUser(userId);
    // socketsSeeingUser only returns *other* sockets watching this user
    // (member list windows / presenceSubs) — it never includes the
    // actor's own connections, so without this a client's other active
    // sessions (e.g. mobile + desktop signed into the same account)
    // never learn about a status change made elsewhere.
    const own = PresenceBucket.socketsByUserId(userId);
    const targets = new Set([...seenBy, ...own]);
    const payload = { userId, presence };

    await Promise.allSettled([
      // Direct send to sockets tracking this user via member lists /
      // presenceSubs, plus the user's own other sessions.
      ...[...targets].map((socket) =>
        Send(socket, {
          op: "Dispatch",
          t: "PresenceUpdate",
          d: payload,
          s: socket.sequence++,
        }).catch((error) => {
          logger.debug("[Presence] send fail:", error);
        }),
      ),
      // Publish to the user's exchange so SubscribeUser listeners receive it
      emitEvent({
        event: "PresenceUpdate",
        user_id: userId,
        data: payload,
      }).catch((error) => {
        logger.debug("[Presence] emit fail:", error);
      }),
    ]);

    this.scheduleResyncForTargets(userId, seenBy);
  }

  private static async notifyScheduleChanged(
    userId: string,
    schedule: PresenceSchedule | null,
  ) {
    const seenBy = PresenceBucket.socketsSeeingUser(userId);
    const selfSockets = PresenceBucket.socketsByUserId(userId);

    const allTargets = new Set<WebSocket>([...seenBy, ...selfSockets]);
    if (allTargets.size === 0) return;

    const payload = { userId, schedule };

    await Promise.allSettled(
      [...allTargets].map((socket) =>
        Send(socket, {
          op: "Dispatch",
          t: "PresenceScheduleUpdate",
          d: payload,
          s: socket.sequence++,
        }).catch((error) => {
          logger.debug("[PresenceSchedule] send fail:", error);
        }),
      ),
    );
  }

  private static async notifyCustomStatusScheduleChanged(
    userId: string,
    schedule: CustomStatusSchedule | null,
  ) {
    const seenBy = PresenceBucket.socketsSeeingUser(userId);
    const selfSockets = PresenceBucket.socketsByUserId(userId);

    const allTargets = new Set<WebSocket>([...seenBy, ...selfSockets]);
    if (allTargets.size === 0) return;

    const payload = { userId, schedule };

    await Promise.allSettled(
      [...allTargets].map((socket) =>
        Send(socket, {
          op: "Dispatch",
          t: "CustomStatusScheduleUpdate",
          d: payload,
          s: socket.sequence++,
        }).catch((error) => {
          logger.debug("[CustomStatusSchedule] send fail:", error);
        }),
      ),
    );
  }

  private static async getSchedule(
    userId: string,
  ): Promise<PresenceSchedule | null> {
    const raw = await redis.get(SCHEDULE_KEY(userId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as PresenceSchedule;
      if (!parsed) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private static async setSchedule(userId: string, schedule: PresenceSchedule) {
    if (schedule.until <= Date.now()) {
      await this.clearSchedule(userId);
      return;
    }

    await redis.set(SCHEDULE_KEY(userId), JSON.stringify(schedule));
    await redis.zadd(SCHEDULE_ZSET, String(schedule.until), userId);
  }

  private static async expireSchedule(
    userId: string,
    schedule: PresenceSchedule,
  ) {
    await this.store.warmFromRedis(userId).catch(() => null);
    const current = await this.store.get(userId);

    const reverted = this.store.upsert(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: schedule.revertTo ?? "online",
    });

    await this.clearSchedule(userId);
    await this.notifyScheduleChanged(userId, null);

    return reverted;
  }

  private static async clearSchedule(userId: string) {
    await redis.del(SCHEDULE_KEY(userId));
    await redis.zrem(SCHEDULE_ZSET, userId);
  }

  private static async getCustomStatusSchedule(
    userId: string,
  ): Promise<CustomStatusSchedule | null> {
    const raw = await redis.get(CUSTOM_STATUS_SCHEDULE_KEY(userId));
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as CustomStatusSchedule;
      if (!parsed) return null;
      if (!parsed.text?.trim() && !sanitizeActivityEmoji(parsed.emoji))
        return null;

      return {
        ...parsed,
        text: parsed.text?.trim() ?? "",
        emoji: sanitizeActivityEmoji(parsed.emoji) ?? null,
        revertTo: normalizeCustomStatusSnapshot(parsed.revertTo),
      };
    } catch {
      return null;
    }
  }

  private static async setCustomStatusSchedule(
    userId: string,
    schedule: CustomStatusSchedule,
  ) {
    if (schedule.until <= Date.now()) {
      await this.clearCustomStatusSchedule(userId);
      return;
    }

    await redis.set(
      CUSTOM_STATUS_SCHEDULE_KEY(userId),
      JSON.stringify(schedule),
    );
    await redis.zadd(
      CUSTOM_STATUS_SCHEDULE_ZSET,
      String(schedule.until),
      userId,
    );
  }

  private static async expireCustomStatusSchedule(
    userId: string,
    schedule: CustomStatusSchedule,
  ) {
    await this.store.warmFromRedis(userId).catch(() => null);
    const current = await this.store.get(userId);
    const activities = applyCustomStatusSnapshot(
      current?.activities ?? [],
      normalizeCustomStatusSnapshot(schedule.revertTo),
    );

    const reverted = this.store.upsert(userId, {
      ...(current ?? { activities: [], device: "web", status: "online" }),
      activities,
    });

    await this.clearCustomStatusSchedule(userId);
    await this.notifyCustomStatusScheduleChanged(userId, null);

    return reverted;
  }

  private static async clearCustomStatusSchedule(userId: string) {
    await redis.del(CUSTOM_STATUS_SCHEDULE_KEY(userId));
    await redis.zrem(CUSTOM_STATUS_SCHEDULE_ZSET, userId);
  }

  private static ensureScheduleLoop() {
    if (this.scheduleLoopStarted) return;
    this.scheduleLoopStarted = true;

    setInterval(async () => {
      const lock = await redis.set(SCHEDULE_LOCK, "1", "PX", 5000, "NX");
      if (lock !== "OK") return;

      try {
        await this.processDueSchedules();
        await this.processDueCustomStatusSchedules();
      } catch (error) {
        logger.debug("[PresenceSchedule] worker error:", error);
      }
    }, 1000).unref?.();
  }

  private static async revertScheduledStatus(
    userId: string,
    schedule: PresenceSchedule,
  ) {
    const reverted = await this.expireSchedule(userId, schedule);
    await this.broadcast(userId, reverted);
  }

  private static async revertOrphanedSchedule(userId: string) {
    await this.store.warmFromRedis(userId).catch(() => null);
    const current = await this.store.get(userId);
    if (!current || current.status === "offline") return;

    const manual = await this.getManualStatus(userId).catch(() => null);
    const reverted = this.store.upsert(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: manual ?? "online",
    });

    await this.broadcast(userId, reverted);
    await this.notifyScheduleChanged(userId, null);
  }

  private static async processDueSchedules() {
    const now = Date.now();

    const dueUserIds = await redis.zrangebyscore(
      SCHEDULE_ZSET,
      "-inf",
      String(now),
      "LIMIT",
      0,
      200,
    );

    if (!dueUserIds.length) return;

    for (const userId of dueUserIds) {
      const schedule = await this.getSchedule(userId);

      if (!schedule) {
        await redis.zrem(SCHEDULE_ZSET, userId);
        await this.revertOrphanedSchedule(userId);
        continue;
      }

      if (schedule.until > now) continue;

      await this.revertScheduledStatus(userId, schedule);
    }
  }

  private static async revertScheduledCustomStatus(
    userId: string,
    schedule: CustomStatusSchedule,
  ) {
    const reverted = await this.expireCustomStatusSchedule(userId, schedule);
    await this.broadcast(userId, reverted);
  }

  private static async revertOrphanedCustomStatusSchedule(userId: string) {
    await this.store.warmFromRedis(userId).catch(() => null);
    const current = await this.store.get(userId);
    if (!current || current.status === "offline") return;

    const reverted = this.store.upsert(userId, {
      ...current,
      activities: removeCustomStatus(current.activities ?? []),
    });

    await this.broadcast(userId, reverted);
    await this.notifyCustomStatusScheduleChanged(userId, null);
  }

  private static async processDueCustomStatusSchedules() {
    const now = Date.now();

    const dueUserIds = await redis.zrangebyscore(
      CUSTOM_STATUS_SCHEDULE_ZSET,
      "-inf",
      String(now),
      "LIMIT",
      0,
      200,
    );

    if (!dueUserIds.length) return;

    for (const userId of dueUserIds) {
      const schedule = await this.getCustomStatusSchedule(userId);

      if (!schedule) {
        await redis.zrem(CUSTOM_STATUS_SCHEDULE_ZSET, userId);
        await this.revertOrphanedCustomStatusSchedule(userId);
        continue;
      }

      if (schedule.until > now) continue;

      await this.revertScheduledCustomStatus(userId, schedule);
    }
  }
}
