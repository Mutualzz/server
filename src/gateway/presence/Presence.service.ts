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
  MAX_STR,
} from "./Presence.validator.ts";
import { logger } from "../Logger";
import { PresenceBucket } from "./Presence.bucket.ts";
import { offlineLike, resyncMemberListWindows } from "../util/Calculations";
import { emitEvent, redis } from "@mutualzz/util";
import { db, userSettingsTable } from "@mutualzz/database";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { findGameByName } from "../../util/GameCatalog.ts";
import { recordEndedActivities } from "../../util/ActivityHistory.ts";
import type Redis from "ioredis";

type ResyncKey = string;

const SCHEDULE_KEY = (userId: string) => `presence:schedule:${userId}`;
const MANUAL_KEY = (userId: string) => `presence:manual:${userId}`;
const MANUAL_CUSTOM_KEY = (userId: string) =>
  `presence:custom-manual:${userId}`;

const SCHEDULE_ZSET = `presence:schedules`; // member=userId score=until(ms)
const SCHEDULE_LOCK = `presence:schedule:worker-lock`;

const CUSTOM_STATUS_SCHEDULE_KEY = (userId: string) =>
  `presence:custom-status:${userId}`;
const CUSTOM_STATUS_SCHEDULE_ZSET = `presence:custom-status-schedules`;

const PRESENCE_BROADCAST_CHANNEL = "presence:broadcast";
const INSTANCE_ID = randomUUID();
const DISCONNECT_GRACE_MS = 1_500;

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

  return [buildCustomActivity(trimmed, emoji), ...withoutCustom];
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

export function toPublicPresence(
  presence: PresencePayload | null,
): PresencePayload | null {
  if (!presence) return null;
  if (presence.status !== "invisible") return presence;

  return {
    status: "offline",
    activities: [],
    updatedAt: presence.updatedAt,
    ...(presence.device ? { device: presence.device } : {}),
  };
}

export class PresenceService {
  private static store = new PresenceStore();
  private static started = false;

  private static resyncTimers = new Map<ResyncKey, NodeJS.Timeout>();

  private static scheduleLoopStarted = false;
  private static pubsubStarted = false;
  private static subscriber: Redis | null = null;

  static startBackgroundWorkers() {
    this.ensureGcLoop();
    this.ensureScheduleLoop();
    this.ensurePubSub();
  }

  static toPublicPresence = toPublicPresence;

  static async onSocketAuthenticated(ws: WebSocket) {
    this.startBackgroundWorkers();

    PresenceBucket.add(ws);

    ws.memberListSubs = ws.memberListSubs ?? new Map();
    ws.presences = ws.presences ?? new Map();

    if (!ws.userId || !ws.sessionId) return;

    await this.store.warmFromRedis(ws.userId).catch(() => null);

    const scheduled = await this.getSchedule(ws.userId).catch(() => null);
    const customScheduled = await this.getCustomStatusSchedule(ws.userId).catch(
      () => null,
    );
    const manual = await this.getManualStatus(ws.userId).catch(() => null);
    const manualCustom = await this.getManualCustomStatus(ws.userId).catch(
      () => null,
    );

    let existing = await this.store.get(ws.userId);
    if (existing?.status === "offline") existing = null;

    let sessionStatus: PresenceStatus =
      existing && existing.status !== "offline" ? existing.status : "online";
    if (scheduled && scheduled.until > Date.now())
      sessionStatus = scheduled.status;
    else if (manual) sessionStatus = manual;

    let sessionActivities: PresenceActivity[] = [];
    if (customScheduled && customScheduled.until > Date.now()) {
      sessionActivities = applyCustomStatus(
        [],
        customScheduled.text,
        customScheduled.emoji,
      );
    } else if (manualCustom) {
      sessionActivities = applyCustomStatus(
        [],
        manualCustom.text ?? "",
        manualCustom.emoji,
      );
    }

    if (scheduled && scheduled.until <= Date.now()) {
      await this.expireSchedule(ws.userId, scheduled);
    }
    if (customScheduled && customScheduled.until <= Date.now()) {
      await this.expireCustomStatusSchedule(ws.userId, customScheduled);
    }

    let presence = await this.store.upsertSession(ws.userId, ws.sessionId, {
      status: sessionStatus,
      activities: sessionActivities,
      device: "web",
    });

    presence = await this.applyOverlaysAndWrite(ws.userId, presence);

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

  static async getPublic(userId: string) {
    return toPublicPresence(await this.store.get(userId));
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

  static minecraftSessionId(bridgeId: string) {
    return `minecraft:${bridgeId}`;
  }

  static async clearMinecraftBridgeActivity(userId: string, bridgeId: string) {
    this.startBackgroundWorkers();

    const sessionId = this.minecraftSessionId(bridgeId);
    const previous = (await this.store.get(userId).catch(() => null)) ?? null;
    const { merged, remaining } = await this.store.removeSession(
      userId,
      sessionId,
    );

    if (remaining > 0) {
      const presence = await this.applyOverlaysAndWrite(userId, merged);
      void recordEndedActivities(
        userId,
        previous?.activities ?? [],
        presence.activities,
      ).catch(() => null);
      await this.broadcast(userId, presence);
      return;
    }

    void recordEndedActivities(userId, previous?.activities ?? [], []).catch(
      () => null,
    );
    await this.broadcast(userId, merged);
  }

  static async clearAllMinecraftBridgeActivities(userId: string) {
    this.startBackgroundWorkers();

    const sessions = await redis
      .hkeys(`presence:sessions:${userId}`)
      .catch(() => [] as string[]);
    const minecraftSessions = sessions.filter((id) =>
      id.startsWith("minecraft:"),
    );
    if (!minecraftSessions.length) return;

    for (const sessionId of minecraftSessions) {
      await this.store.removeSession(userId, sessionId);
    }

    const presence =
      (await this.store.get(userId)) ?? this.store.setOffline(userId);
    const withOverlays =
      presence.status === "offline"
        ? presence
        : await this.applyOverlaysAndWrite(userId, presence);
    await this.broadcast(userId, withOverlays);
  }

  static async setMinecraftBridgeActivity(
    userId: string,
    opts: {
      bridgeId: string;
      serverName?: string | null;
    },
  ) {
    this.startBackgroundWorkers();

    const settings = await db.query.userSettingsTable
      .findFirst({
        where: eq(userSettingsTable.userId, BigInt(userId)),
        columns: { shareActivity: true },
      })
      .catch(() => null);

    if (settings && !settings.shareActivity) {
      await this.clearAllMinecraftBridgeActivities(userId);
      return;
    }

    const sessionId = this.minecraftSessionId(opts.bridgeId);
    const existing = await this.store.getSession(userId, sessionId);
    const start =
      existing?.activities?.find((a) => a.type === "playing")?.timestamps
        ?.start ?? Date.now();

    const serverName = opts.serverName?.trim().slice(0, MAX_STR) || undefined;
    const minecraft = await findGameByName("Minecraft").catch(() => null);

    let presence = await this.store.upsertSession(userId, sessionId, {
      status: "online",
      activities: [
        {
          type: "playing",
          name: "Minecraft",
          ...(minecraft ? { applicationId: minecraft.id } : {}),
          ...(serverName ? { details: serverName } : {}),
          timestamps: { start },
        },
      ],
    });
    presence = await this.applyOverlaysAndWrite(userId, presence);
    await this.broadcast(userId, presence);
  }

  static async handleUpdate(ws: WebSocket, rawPresence: any) {
    this.ensureGcLoop();
    this.ensureScheduleLoop();
    this.ensurePubSub();

    if (!ws.userId || !ws.sessionId) {
      ws.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
      return;
    }

    const persist = Boolean(rawPresence?.persist);
    const presenceInput = rawPresence?.presence ?? rawPresence;

    const clean = sanitizePresence(presenceInput);

    if (persist && clean.status === "offline") return;

    const shareActivityRow = await db.query.userSettingsTable
      .findFirst({
        where: eq(userSettingsTable.userId, BigInt(ws.userId)),
        columns: { shareActivity: true },
      })
      .catch(() => null);
    if (shareActivityRow?.shareActivity === false) {
      clean.activities = clean.activities.filter((a) => a.type === "custom");
    }

    const scheduled = await this.getSchedule(ws.userId).catch(() => null);
    if (scheduled && scheduled.until > Date.now())
      clean.status = scheduled.status;
    else if (persist)
      await this.setManualStatus(ws.userId, clean.status).catch(() => null);

    const customScheduled = await this.getCustomStatusSchedule(ws.userId).catch(
      () => null,
    );
    if (customScheduled && customScheduled.until > Date.now()) {
      clean.activities = applyCustomStatus(
        clean.activities,
        customScheduled.text,
        customScheduled.emoji,
      );
    } else if (persist) {
      const custom = getCustomStatusSnapshot(clean.activities);
      await this.setManualCustomStatus(ws.userId, custom).catch(() => null);
    }

    const previous =
      (await this.store.get(ws.userId).catch(() => null)) ?? null;

    let presence: PresencePayload;
    if (persist && !(scheduled && scheduled.until > Date.now())) {
      presence = await this.store.setAllSessionsStatus(
        ws.userId,
        ws.sessionId,
        clean,
      );
    } else {
      presence = await this.store.upsertSession(ws.userId, ws.sessionId, clean);
    }
    presence = await this.applyOverlaysAndWrite(ws.userId, presence);

    if (shareActivityRow?.shareActivity !== false) {
      void recordEndedActivities(
        ws.userId,
        previous?.activities ?? [],
        presence.activities,
      ).catch(() => null);
    }

    await this.broadcast(ws.userId, presence, previous);
  }

  static async onDisconnect(userId?: string, sessionId?: string) {
    if (!userId) return;
    this.ensureGcLoop();
    this.ensureScheduleLoop();
    this.ensurePubSub();

    setTimeout(async () => {
      if (sessionId) {
        const sessionStillConnected = PresenceBucket.socketsByUserId(
          userId,
        ).some((ws) => ws.sessionId === sessionId);
        if (sessionStillConnected) return;
      }

      if (PresenceBucket.hasAnyAuthenticatedSocket(userId)) {
        if (sessionId) {
          const previous =
            (await this.store.get(userId).catch(() => null)) ?? null;
          const { merged, remaining } = await this.store.removeSession(
            userId,
            sessionId,
          );
          if (remaining > 0) {
            const presence = await this.applyOverlaysAndWrite(userId, merged);
            void recordEndedActivities(
              userId,
              previous?.activities ?? [],
              presence.activities,
            ).catch(() => null);
            await this.broadcast(userId, presence, previous);
          } else {
            void recordEndedActivities(
              userId,
              previous?.activities ?? [],
              [],
            ).catch(() => null);
            await this.broadcast(userId, merged, previous);
          }
        }
        return;
      }

      const previous = (await this.store.get(userId).catch(() => null)) ?? null;

      if (sessionId) {
        await this.store.removeSession(userId, sessionId);
      } else {
        const presence = this.store.setOffline(userId);
        void recordEndedActivities(
          userId,
          previous?.activities ?? [],
          [],
        ).catch(() => null);
        await this.broadcast(userId, presence, previous);
        return;
      }

      const presence =
        (await this.store.get(userId)) ?? this.store.setOffline(userId);
      void recordEndedActivities(
        userId,
        previous?.activities ?? [],
        presence.status === "offline" ? [] : presence.activities,
      ).catch(() => null);
      await this.broadcast(userId, presence, previous);
    }, DISCONNECT_GRACE_MS).unref?.();
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

    if (opts.durationMs <= 0) {
      await this.clearSchedule(userId);
      await this.setManualStatus(userId, opts.status).catch(() => null);
      const applied = this.store.writeMerged(userId, {
        ...(current ?? { activities: [], device: "web" }),
        status: opts.status,
        updatedAt: now,
      });
      await this.broadcast(userId, applied);
      await this.notifyScheduleChanged(userId, null);
      return;
    }

    const schedule: PresenceSchedule = {
      status: opts.status,
      revertTo,
      until: now + opts.durationMs,
    };

    await this.setSchedule(userId, schedule);

    const applied = this.store.writeMerged(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: schedule.status,
      updatedAt: now,
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

      const reverted = this.store.writeMerged(userId, {
        ...(current ?? { activities: [], device: "web" }),
        status: existing.revertTo ?? "online",
        updatedAt: Date.now(),
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

    if (opts.durationMs <= 0) {
      await this.clearCustomStatusSchedule(userId);
      await this.setManualCustomStatus(userId, { text, emoji }).catch(
        () => null,
      );
      const applied = this.store.writeMerged(userId, {
        ...(current ?? { activities: [], device: "web", status: "online" }),
        activities: applyCustomStatus(current?.activities ?? [], text, emoji),
        updatedAt: now,
      });
      await this.broadcast(userId, applied);
      await this.notifyCustomStatusScheduleChanged(userId, null);
      return;
    }

    const schedule: CustomStatusSchedule = {
      text,
      emoji,
      revertTo,
      until: now + opts.durationMs,
    };

    await this.setCustomStatusSchedule(userId, schedule);

    const applied = this.store.writeMerged(userId, {
      ...(current ?? { activities: [], device: "web", status: "online" }),
      activities: applyCustomStatus(current?.activities ?? [], text, emoji),
      updatedAt: now,
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

      const reverted = this.store.writeMerged(userId, {
        ...(current ?? { activities: [], device: "web", status: "online" }),
        activities,
        updatedAt: Date.now(),
      });

      await this.broadcast(userId, reverted);
    }

    await this.notifyCustomStatusScheduleChanged(userId, null);
  }

  private static async applyOverlaysAndWrite(
    userId: string,
    base: PresencePayload,
  ): Promise<PresencePayload> {
    const presence = { ...base, activities: [...(base.activities ?? [])] };

    const scheduled = await this.getSchedule(userId).catch(() => null);
    if (scheduled && scheduled.until > Date.now()) {
      presence.status = scheduled.status;
    }

    const customScheduled = await this.getCustomStatusSchedule(userId).catch(
      () => null,
    );
    if (customScheduled && customScheduled.until > Date.now()) {
      presence.activities = applyCustomStatus(
        presence.activities,
        customScheduled.text,
        customScheduled.emoji,
      );
    } else {
      const hasCustom = presence.activities.some((a) => a.type === "custom");
      if (!hasCustom) {
        const manualCustom = await this.getManualCustomStatus(userId).catch(
          () => null,
        );
        if (manualCustom) {
          presence.activities = applyCustomStatus(
            presence.activities,
            manualCustom.text ?? "",
            manualCustom.emoji,
          );
        }
      }
    }

    return this.store.writeMerged(userId, {
      ...presence,
      updatedAt: Date.now(),
    });
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

  private static async getManualCustomStatus(
    userId: string,
  ): Promise<CustomStatusSnapshot | null> {
    const raw = await redis.get(MANUAL_CUSTOM_KEY(userId));
    if (!raw) return null;
    try {
      return normalizeCustomStatusSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private static async setManualCustomStatus(
    userId: string,
    snapshot: CustomStatusSnapshot | null,
  ) {
    if (!snapshot || (!snapshot.text?.trim() && !snapshot.emoji)) {
      await redis.del(MANUAL_CUSTOM_KEY(userId));
      return;
    }
    await redis.set(MANUAL_CUSTOM_KEY(userId), JSON.stringify(snapshot));
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

  private static ensurePubSub() {
    if (this.pubsubStarted) return;
    this.pubsubStarted = true;

    try {
      this.subscriber = redis.duplicate();
      void this.subscriber
        .subscribe(PRESENCE_BROADCAST_CHANNEL)
        .catch((error) => {
          logger.debug("[Presence] pubsub subscribe failed:", error);
        });

      this.subscriber.on("message", (channel, message) => {
        if (channel !== PRESENCE_BROADCAST_CHANNEL) return;
        try {
          const parsed = JSON.parse(message) as {
            userId: string;
            presence: PresencePayload;
            origin?: string;
          };
          if (!parsed?.userId || !parsed?.presence) return;
          if (parsed.origin === INSTANCE_ID) return;

          void this.fanoutLocal(parsed.userId, parsed.presence, {
            publish: false,
          });
        } catch (error) {
          logger.debug("[Presence] pubsub message error:", error);
        }
      });
    } catch (error) {
      logger.debug("[Presence] pubsub init failed:", error);
    }
  }

  private static scheduleResyncForTargets(
    userId: string,
    targets: WebSocket[],
    opts?: { forceAllSubs?: boolean },
  ) {
    for (const socket of targets) {
      const presencesBySubKey = socket.presences;
      const subKeys = new Set<string>();

      if (presencesBySubKey) {
        for (const [subKey, visibleUserIds] of presencesBySubKey) {
          if (!opts?.forceAllSubs && !visibleUserIds?.has(userId)) continue;
          subKeys.add(subKey);
        }
      }

      if (opts?.forceAllSubs && socket.memberListSubs?.size) {
        for (const sub of socket.memberListSubs.values()) {
          subKeys.add(`${sub.spaceId}:${sub.channelId}:${sub.listId}`);
        }
      }

      for (const subKey of subKeys) {
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

  private static async fanoutLocal(
    userId: string,
    presence: PresencePayload,
    opts?: { publish?: boolean; previous?: PresencePayload | null },
  ) {
    const seenBy = PresenceBucket.socketsSeeingUser(userId);
    const own = PresenceBucket.socketsByUserId(userId);
    const targets = new Set([...seenBy, ...own]);
    const publicPresence = toPublicPresence(presence) ?? presence;
    const offlineFlipped =
      offlineLike(opts?.previous ?? null) !== offlineLike(presence);

    await Promise.allSettled(
      [...targets].map((socket) => {
        const forSelf = socket.userId === userId;
        return Send(socket, {
          op: "Dispatch",
          t: "PresenceUpdate",
          d: {
            userId,
            presence: forSelf ? presence : publicPresence,
          },
          s: socket.sequence++,
        }).catch((error) => {
          logger.debug("[Presence] send fail:", error);
        });
      }),
    );

    if (opts?.publish !== false) {
      await Promise.allSettled([
        emitEvent({
          event: "PresenceUpdate",
          user_id: userId,
          data: { userId, presence: publicPresence },
        }).catch((error) => {
          logger.debug("[Presence] emit fail:", error);
        }),
        redis
          .publish(
            PRESENCE_BROADCAST_CHANNEL,
            JSON.stringify({
              userId,
              presence,
              origin: INSTANCE_ID,
            }),
          )
          .catch((error) => {
            logger.debug("[Presence] publish fail:", error);
          }),
      ]);
    }

    let resyncTargets = seenBy;
    if (offlineFlipped) {
      const memberListWatchers = PresenceBucket.authenticatedSockets().filter(
        (ws) => (ws.memberListSubs?.size ?? 0) > 0,
      );
      resyncTargets = [...new Set([...seenBy, ...memberListWatchers])];
    }

    this.scheduleResyncForTargets(userId, resyncTargets, {
      forceAllSubs: offlineFlipped,
    });
  }

  private static async broadcast(
    userId: string,
    presence: PresencePayload,
    previous?: PresencePayload | null,
  ) {
    await this.fanoutLocal(userId, presence, { publish: true, previous });
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

    const reverted = this.store.writeMerged(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: schedule.revertTo ?? "online",
      updatedAt: Date.now(),
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

    const reverted = this.store.writeMerged(userId, {
      ...(current ?? { activities: [], device: "web", status: "online" }),
      activities,
      updatedAt: Date.now(),
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
    const reverted = this.store.writeMerged(userId, {
      ...(current ?? { activities: [], device: "web" }),
      status: manual ?? "online",
      updatedAt: Date.now(),
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

    const manualCustom = await this.getManualCustomStatus(userId).catch(
      () => null,
    );
    const activities = manualCustom
      ? applyCustomStatus(
          removeCustomStatus(current.activities ?? []),
          manualCustom.text ?? "",
          manualCustom.emoji,
        )
      : removeCustomStatus(current.activities ?? []);

    const reverted = this.store.writeMerged(userId, {
      ...current,
      activities,
      updatedAt: Date.now(),
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
