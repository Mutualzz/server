import crypto from "crypto";
import { ChannelType, type Snowflake } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import { VoiceStateRedis } from "./VoiceState.redis";
import type { VoiceState, VoiceStateUpdateBody } from "./VoiceState.types";
import {
  createVoiceSession,
  emitEvent,
  generateVoiceToken,
  redis,
  touchVoiceSessionTtls,
} from "@mutualzz/util";
import { canVoiceConnect, canVoiceSpeak } from "../util/VoicePermissions.ts";
import { logger } from "../Logger.ts";
import { voiceScopeKey } from "./VoiceState.util";
import { PresenceBucket } from "../presence/Presence.bucket.ts";
import { and, eq } from "drizzle-orm";
import {
  channelsTable,
  channelRecipientsTable,
  db,
  voiceModerationTable,
} from "@mutualzz/database";
import { INSTANCE_ID } from "../../util/InstanceId.ts";
import { RESUME_WINDOW_MS } from "../util/Constants";
import { CallService } from "../call/Call.service";
import { CallRedis } from "../call/Call.redis";
import {
  MinecraftVoicePeers,
  setMinecraftVoicePeerLocalMuted,
} from "../../minecraft/voice/MinecraftVoicePeers.ts";
import {
  getMinecraftVoicePeerLocation,
  mintMinecraftAudioToken,
  revokeMinecraftAudioTokenForUser,
} from "../../minecraft/voice/audioTokens.ts";
import { findOnlinePlayer } from "../../minecraft/OnlinePlayers.ts";
import {
  sessionsForBridge,
  sendToSocket,
} from "../../minecraft/SessionRegistry.ts";

export class VoiceStateService {
  static readonly instanceId: string = INSTANCE_ID;

  private static readonly STREAM_CHUNK_SIZE = 25;
  private static readonly STREAM_PAUSE_MS = 10;
  private static readonly DETACHED_VOICE_LEAVE_MS = RESUME_WINDOW_MS;
  private static readonly detachedLeaveTimers = new Map<
    string,
    NodeJS.Timeout
  >();

  private static async publishVoiceKick(params: {
    userId: Snowflake | string;
    spaceId?: Snowflake | null;
    roomId?: string | null;
    sessionId?: string | null;
    reason: string;
  }) {
    try {
      const payload = JSON.stringify({
        userId: String(params.userId),
        spaceId: params.spaceId ?? null,
        roomId: params.roomId ?? null,
        sessionId: params.sessionId ?? null,
        reason: params.reason,
        instanceId: this.instanceId,
      });
      await redis.publish("voice:control:kick", payload);
    } catch (err) {
      logger.error("Failed to publish voice kick control event", err);
    }
  }

  private static async publishVoiceModeration(params: {
    userId: Snowflake | string;
    roomId: string;
    muted: boolean;
    deafened: boolean;
  }) {
    try {
      await redis.publish(
        "voice:control:kick",
        JSON.stringify({
          action: "moderation",
          userId: String(params.userId),
          roomId: params.roomId,
          muted: params.muted,
          deafened: params.deafened,
          instanceId: this.instanceId,
        }),
      );
    } catch (err) {
      logger.error("Failed to publish voice moderation control event", err);
    }
  }

  private static getVoiceEndpoint() {
    const endpoint = process.env.VOICE_ENDPOINT?.trim();
    if (!endpoint) {
      logger.error(
        "VOICE_ENDPOINT is not configured; clients cannot connect to voice",
      );
      return null;
    }
    return endpoint;
  }

  private static async issueVoiceServerUpdate(
    socket: WebSocket,
    params: {
      roomId: string;
      spaceId: Snowflake | null;
      channelId: Snowflake;
      userId: Snowflake;
      sessionId: string;
    },
  ) {
    const voiceEndpoint = this.getVoiceEndpoint();
    if (!voiceEndpoint) {
      await this.rejectVoiceJoin(
        socket,
        params.userId,
        params.spaceId,
        "Voice server is not configured",
      );
      return false;
    }

    const tokenId = crypto.randomUUID();
    const voiceToken = generateVoiceToken(
      params.userId.toString(),
      params.sessionId,
      params.roomId,
      tokenId,
    );

    await VoiceStateRedis.setActiveSession({
      userId: params.userId,
      sessionId: params.sessionId,
      roomId: params.roomId,
      tokenId,
      updatedAt: Date.now(),
    });

    await createVoiceSession(
      voiceToken,
      params.userId,
      params.sessionId,
      params.roomId,
      undefined,
      tokenId,
    );

    await Send(socket, {
      op: "Dispatch",
      t: "VoiceServerUpdate",
      s: SessionRuntime.nextSequence(socket.sessionId, socket),
      d: {
        roomId: params.roomId,
        spaceId: params.spaceId,
        channelId: params.channelId,
        voiceEndpoint,
        voiceToken,
        sessionId: params.sessionId,
      },
    });

    return true;
  }

  static async handleVoiceStateUpdate(
    socket: WebSocket,
    body: VoiceStateUpdateBody,
  ) {
    if (!socket.userId || !socket.sessionId) return;

    const userId = socket.userId;
    const sessionId = socket.sessionId;

    const requestedChannelId = body.channelId ?? null;
    const spaceId = body.spaceId ?? null;

    const selfMuteRequested = body.selfMute === true;
    const selfDeafRequested = body.selfDeaf === true;
    const refreshRtcRequested = body.refreshRtc === true;

    const previous = await VoiceStateRedis.getState(userId);
    if (!requestedChannelId) {
      // App leave must not tear down an active Minecraft voice session.
      if (previous?.client === "minecraft") {
        logger.debug(
          "Ignoring app voice leave while user is on Minecraft voice",
          { userId: String(userId) },
        );
        if (previous.channelId) {
          try {
            await Send(socket, {
              op: "Dispatch",
              t: "VoiceStateUpdate",
              s: SessionRuntime.nextSequence(socket.sessionId, socket),
              d: previous,
            });
          } catch (err) {
            logger.debug(
              "Failed to re-sync Minecraft voice state after ignored leave",
              err,
            );
          }
          void VoiceStateService.streamStatesToSocket(
            socket,
            previous.spaceId ?? null,
            previous.channelId,
            userId,
          );
        }
        return;
      }
      if (previous) {
        await VoiceStateService.publishVoiceKick({
          userId,
          spaceId: previous.spaceId,
          roomId: previous.channelId
            ? voiceScopeKey(previous.spaceId, previous.channelId)
            : null,
          sessionId: previous.sessionId,
          reason: "left",
        });

        const active = await VoiceStateRedis.getActiveSession(userId);
        if (active) {
          try {
            await VoiceStateRedis.clearActiveSession(userId, active.tokenId);
          } catch {
            /* empty */
          }
        }

        const removed = await VoiceStateRedis.removeState({
          userId,
          spaceId: previous.spaceId ?? null,
          channelId: previous.channelId,
          sessionId: null,
        });
        if (!removed) {
          await VoiceStateRedis.removeStateBestEffort(userId);
        }

        const leftChannelId = previous.channelId;
        const leftSpaceId = previous.spaceId ?? null;

        await VoiceStateService.emitVoiceStateUpdate(
          leftSpaceId,
          leftChannelId,
          {
            userId,
            spaceId: leftSpaceId,
            channelId: null,
          },
        );

        if (leftChannelId) {
          void VoiceStateService.emitChannelVoiceStateSync(
            leftSpaceId,
            leftChannelId,
          );
        }

        if (leftSpaceId == null && leftChannelId) {
          void CallService.onVoiceOccupancyChanged(leftChannelId);
        }
      }

      return;
    }

    // App auto-rejoin / refresh must not steal an active Minecraft voice session.
    const incomingClient = body.client;
    if (
      previous?.client === "minecraft" &&
      previous.channelId &&
      incomingClient !== "minecraft"
    ) {
      logger.debug(
        "Ignoring app VoiceStateUpdate while user is on Minecraft voice",
        {
          userId: String(userId),
          incomingClient: incomingClient ?? null,
        },
      );
      try {
        await Send(socket, {
          op: "Dispatch",
          t: "VoiceStateUpdate",
          s: SessionRuntime.nextSequence(socket.sessionId, socket),
          d: previous,
        });
      } catch (err) {
        logger.debug(
          "Failed to re-sync Minecraft voice state after ignored join",
          err,
        );
      }
      void VoiceStateService.streamStatesToSocket(
        socket,
        previous.spaceId ?? spaceId,
        previous.channelId,
        socket.userId,
      );
      return;
    }

    const isDmVoice = spaceId == null;

    if (!isDmVoice) {
      const hasConnect = await canVoiceConnect({
        spaceId,
        channelId: requestedChannelId,
        userId,
      });

      if (!hasConnect) {
        logger.debug(
          `User ${userId} attempted to join voice channel ${requestedChannelId} in space ${spaceId} without permission`,
        );
        await this.rejectVoiceJoin(
          socket,
          userId,
          spaceId,
          "Missing permission to connect to this voice channel",
          true,
        );
        return;
      }
    } else {
      const hasDmAccess = await this.canJoinDmVoice(requestedChannelId, userId);
      if (!hasDmAccess) {
        logger.debug(
          `User ${userId} attempted to join DM voice channel ${requestedChannelId} without membership`,
        );
        await this.rejectVoiceJoin(
          socket,
          userId,
          spaceId,
          "Missing access to this voice channel",
          true,
        );
        return;
      }

      const activeCall = await CallRedis.getByChannel(requestedChannelId);
      if (!activeCall || activeCall.status === "ended") {
        const alreadyInDm =
          previous?.channelId != null &&
          previous.spaceId == null &&
          String(previous.channelId) === String(requestedChannelId);
        if (alreadyInDm) {
          await this.kickMemberFromVoice(
            null,
            userId,
            "call ended",
            requestedChannelId,
          );
          return;
        }
        logger.debug(
          `User ${userId} attempted to join DM voice without an active call`,
          { channelId: String(requestedChannelId) },
        );
        await this.rejectVoiceJoin(
          socket,
          userId,
          spaceId,
          "No active call in this channel",
          true,
        );
        return;
      }
    }

    const isFirstJoin = previous == null || previous.channelId == null;
    const isMove =
      previous != null &&
      previous.channelId != null &&
      (String(previous.spaceId) !== String(spaceId) ||
        String(previous.channelId) !== String(requestedChannelId));

    const moderation = await this.getMemberVoiceModeration(spaceId, userId);

    const hasSpeak = isDmVoice
      ? true
      : await canVoiceSpeak({
          spaceId,
          channelId: requestedChannelId,
          userId,
        });

    const active = await VoiceStateRedis.getActiveSession(userId);
    let shouldSupersede = false;

    if (active && active.sessionId !== sessionId) {
      try {
        await VoiceStateRedis.clearActiveSession(userId, active.tokenId);

        await VoiceStateService.publishVoiceKick({
          userId,
          spaceId: previous?.spaceId ?? spaceId,
          roomId: active.roomId,
          sessionId: active.sessionId,
          reason: "superseded",
        });

        shouldSupersede = true;

        logger.debug("Superseded active voice session", {
          userId: String(userId),
          oldSessionId: active.sessionId,
        });
      } catch (err) {
        logger.warn(
          "Failed to clear active voice session before supersede",
          err,
        );
        await this.rejectVoiceJoin(
          socket,
          userId,
          spaceId,
          "Unable to join voice channel",
        );
        return;
      }
    } else if (
      !active &&
      previous?.channelId != null &&
      previous.sessionId !== sessionId
    ) {
      shouldSupersede = true;
      logger.debug("Superseding expired active voice session", {
        userId: String(userId),
        oldSessionId: previous.sessionId,
      });
    }

    const now = Date.now();
    const next: VoiceState = {
      userId,
      spaceId,
      channelId: requestedChannelId,
      selfMute: selfMuteRequested,
      selfDeaf: selfDeafRequested,
      spaceMute: moderation.spaceMute || !hasSpeak,
      spaceDeaf: moderation.spaceDeaf,
      sessionId,
      updatedAt: now,
            joinedAt:
                isFirstJoin || isMove || shouldSupersede
                    ? now
                    : (previous!.joinedAt ?? now),
      client: body.client ?? previous?.client,
    };

    await VoiceStateRedis.upsertState(next);

    const stateChanged =
      !previous ||
      String(previous.channelId ?? "") !== String(next.channelId ?? "") ||
      String(previous.spaceId ?? "") !== String(next.spaceId ?? "") ||
      previous.selfMute !== next.selfMute ||
      previous.selfDeaf !== next.selfDeaf ||
      previous.spaceMute !== next.spaceMute ||
      previous.spaceDeaf !== next.spaceDeaf ||
      String(previous.sessionId ?? "") !== String(next.sessionId ?? "") ||
      previous.client !== next.client;

    if (stateChanged) {
      await VoiceStateService.emitVoiceStateUpdate(
        spaceId,
        requestedChannelId,
        next,
      );
    }

    if (isFirstJoin || isMove || shouldSupersede || refreshRtcRequested) {
      if (isMove && previous?.channelId) {
        await VoiceStateService.publishVoiceKick({
          userId,
          spaceId: previous.spaceId ?? spaceId,
          roomId: voiceScopeKey(previous.spaceId, previous.channelId),
          sessionId: previous.sessionId,
          reason: "Moved to another voice channel",
        });
      }

      const roomId = voiceScopeKey(spaceId, requestedChannelId);

      const issued = await this.issueVoiceServerUpdate(socket, {
        roomId,
        spaceId,
        channelId: requestedChannelId,
        userId,
        sessionId,
      });
      if (!issued) {
        await VoiceStateRedis.removeState({
          userId,
          spaceId,
          channelId: requestedChannelId,
          sessionId,
        });
        await VoiceStateService.emitVoiceStateUpdate(spaceId, requestedChannelId, {
          userId,
          spaceId,
          channelId: null,
        });
        if (isMove && previous?.channelId) {
          void VoiceStateService.emitStatesAsUpdates(
            previous.spaceId ?? null,
            previous.channelId,
          );
          if (previous.spaceId == null) {
            void CallService.onVoiceOccupancyChanged(previous.channelId);
          }
        }
        if (spaceId == null) {
          void CallService.onVoiceOccupancyChanged(requestedChannelId);
        }
        return;
      }

      void VoiceStateService.streamStatesToSocket(
        socket,
        spaceId,
        requestedChannelId,
        socket.userId,
      );

      if (isMove && previous?.channelId) {
        void VoiceStateService.emitStatesAsUpdates(
          previous.spaceId ?? null,
          previous.channelId,
        );
        if (previous.spaceId == null) {
          void CallService.onVoiceOccupancyChanged(previous.channelId);
        }
      }
      void VoiceStateService.emitStatesAsUpdates(spaceId, requestedChannelId);
    } else {
      await VoiceStateRedis.touchActiveSession(userId);
      await touchVoiceSessionTtls(userId);
    }

    if (spaceId == null) {
      void CallService.onVoiceOccupancyChanged(requestedChannelId);
    }
  }

  static async kickMemberFromVoice(
    spaceId: Snowflake | null,
    targetUserId: Snowflake,
    reason = "Kicked from voice",
    channelId?: Snowflake | null,
  ) {
    const existing = await VoiceStateRedis.getState(targetUserId);
    if (!existing?.channelId) return false;
    if (String(existing.spaceId) !== String(spaceId)) return false;
    if (channelId != null && String(existing.channelId) !== String(channelId))
      return false;

    if (existing.client === "minecraft") {
      await revokeMinecraftAudioTokenForUser(String(targetUserId));
      await MinecraftVoicePeers.leave(String(targetUserId), "kicked");
    }

    await VoiceStateService.publishVoiceKick({
      userId: targetUserId,
      spaceId: existing.spaceId,
      roomId: voiceScopeKey(existing.spaceId, existing.channelId),
      sessionId: existing.sessionId,
      reason,
    });

    const active = await VoiceStateRedis.getActiveSession(targetUserId);
    if (active) {
      try {
        await VoiceStateRedis.clearActiveSession(targetUserId, active.tokenId);
      } catch {
        /* empty */
      }
    }

    const removed = await VoiceStateRedis.removeState({
      userId: targetUserId,
      spaceId,
      channelId: existing.channelId,
      sessionId: existing.sessionId,
    });
    if (!removed) return false;

    await VoiceStateService.emitVoiceStateUpdate(spaceId, existing.channelId, {
      userId: targetUserId,
      spaceId,
      channelId: null,
    });

    void VoiceStateService.emitStatesAsUpdates(spaceId, existing.channelId);

    if (spaceId == null) {
      void CallService.onVoiceOccupancyChanged(existing.channelId!);
    }

    return true;
  }

  static async kickChannelFromVoice(
    spaceId: Snowflake | null,
    channelId: Snowflake,
    reason = "Voice channel deleted",
  ) {
    const states = await VoiceStateRedis.listChannelStates(spaceId, channelId);
    if (!states.length) return 0;

    let kicked = 0;
    for (const state of states) {
      const ok = await this.kickMemberFromVoice(
        state.spaceId ?? null,
        state.userId,
        reason,
        channelId,
      );
      if (ok) kicked++;
    }

    return kicked;
  }

  /**
   * Socket-free join for Minecraft-linked users (no gateway WebSocket).
   * Broadcasts VoiceStateUpdate to the app; returns RTC credentials for the hub peer.
   */
  static async joinFromMinecraft(params: {
    userId: Snowflake;
    spaceId: Snowflake;
    channelId: Snowflake;
  }): Promise<
    | {
        ok: true;
        credentials: {
          roomId: string;
          spaceId: string;
          channelId: string;
          voiceEndpoint: string;
          voiceToken: string;
          sessionId: string;
        };
      }
    | { ok: false; code: string; message: string }
  > {
    const { userId, spaceId, channelId } = params;

    const hasConnect = await canVoiceConnect({
      spaceId,
      channelId,
      userId,
    });
    if (!hasConnect) {
      return {
        ok: false,
        code: "missing_permission",
        message:
          "Missing permission to connect to this voice channel (are you in the space?)",
      };
    }

    const voiceEndpoint = this.getVoiceEndpoint();
    if (!voiceEndpoint) {
      return {
        ok: false,
        code: "voice_unavailable",
        message: "Voice server is not configured",
      };
    }

    const previous = await VoiceStateRedis.getState(userId);
    const sessionId = crypto.randomUUID();
    const moderation = await this.getMemberVoiceModeration(spaceId, userId);
    const hasSpeak = await canVoiceSpeak({
      spaceId,
      channelId,
      userId,
    });

    const now = Date.now();
    const next: VoiceState = {
      userId,
      spaceId,
      channelId,
      selfMute: false,
      selfDeaf: false,
      spaceMute: moderation.spaceMute || !hasSpeak,
      spaceDeaf: moderation.spaceDeaf,
      sessionId,
      updatedAt: now,
      joinedAt: now,
      client: "minecraft",
    };

    const active = await VoiceStateRedis.getActiveSession(userId);
    if (active && active.sessionId !== sessionId) {
      try {
        await VoiceStateRedis.clearActiveSession(userId, active.tokenId);
        await VoiceStateService.publishVoiceKick({
          userId,
          spaceId: previous?.spaceId ?? spaceId,
          roomId: active.roomId,
          sessionId: active.sessionId,
          reason: "superseded",
        });
      } catch (err) {
        logger.warn(
          "Failed to supersede prior voice session for Minecraft join",
          { userId, err },
        );
      }
    }

    if (
      previous?.channelId &&
      (String(previous.spaceId) !== String(spaceId) ||
        String(previous.channelId) !== String(channelId))
    ) {
      await VoiceStateRedis.removeState({
        userId,
        spaceId: previous.spaceId ?? null,
        channelId: previous.channelId,
      });
      await VoiceStateService.emitVoiceStateUpdate(
        previous.spaceId ?? null,
        previous.channelId,
        {
          userId,
          spaceId: previous.spaceId ?? null,
          channelId: null,
        },
      );
      if (previous.channelId) {
        void VoiceStateService.emitStatesAsUpdates(
          previous.spaceId ?? null,
          previous.channelId,
        );
        if (previous.spaceId == null) {
          void CallService.onVoiceOccupancyChanged(previous.channelId);
        }
      }
    }

    await VoiceStateRedis.upsertState(next);
    await VoiceStateService.emitVoiceStateUpdate(spaceId, channelId, next);
    void VoiceStateService.emitStatesAsUpdates(spaceId, channelId);

    const roomId = voiceScopeKey(spaceId, channelId);
    const tokenId = crypto.randomUUID();
    const voiceToken = generateVoiceToken(
      userId.toString(),
      sessionId,
      roomId,
      tokenId,
    );

    await VoiceStateRedis.setActiveSession({
      userId,
      sessionId,
      roomId,
      tokenId,
      updatedAt: Date.now(),
    });
    await createVoiceSession(
      voiceToken,
      userId,
      sessionId,
      roomId,
      undefined,
      tokenId,
    );

    return {
      ok: true,
      credentials: {
        roomId,
        spaceId: spaceId.toString(),
        channelId: channelId.toString(),
        voiceEndpoint,
        voiceToken,
        sessionId,
      },
    };
  }

  static scheduleLeaveIfSessionStillDetached(
    userId: Snowflake,
    sessionId: string,
    delayMs = this.DETACHED_VOICE_LEAVE_MS,
  ) {
    const key = `${String(userId)}:${sessionId}`;
    const existingTimer = this.detachedLeaveTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.detachedLeaveTimers.delete(key);
      void this.leaveIfGatewaySessionDetached(userId, sessionId);
    }, delayMs);
    timer.unref?.();
    this.detachedLeaveTimers.set(key, timer);
  }

  static async leaveIfGatewaySessionDetached(
    userId: Snowflake,
    sessionId: string,
  ) {
    if (SessionRuntime.getLiveSocket(sessionId)) return;
    await this.leaveForExpiredGatewaySession(userId, sessionId);
  }

  static async leaveForExpiredGatewaySession(
    userId: Snowflake,
    sessionId: string,
  ): Promise<boolean> {
    const key = `${String(userId)}:${sessionId}`;
    const pending = this.detachedLeaveTimers.get(key);
    if (pending) {
      clearTimeout(pending);
      this.detachedLeaveTimers.delete(key);
    }

    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId) return false;
    if (existing.client === "minecraft") return false;
    if (existing.sessionId !== sessionId) return false;

    return this.kickMemberFromVoice(
      existing.spaceId,
      userId,
      "Gateway session ended",
    );
  }

  /** Leave voice if the active session is a Minecraft client. */
  static async leaveFromMinecraft(userId: Snowflake): Promise<boolean> {
    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId || !existing.spaceId) {
      await revokeMinecraftAudioTokenForUser(String(userId));
      await MinecraftVoicePeers.leave(String(userId));
      return false;
    }
    if (existing.client !== "minecraft") return false;
    // kickMemberFromVoice closes the hub mediasoup peer when client === minecraft
    return this.kickMemberFromVoice(
      existing.spaceId,
      userId,
      "Left Minecraft voice",
    );
  }

  /** Sync mute/deafen from the Minecraft Fabric mod into voice state for the app UI. */
  static async updateMinecraftSelfState(params: {
    userId: Snowflake;
    selfMute: boolean;
    selfDeaf: boolean;
  }): Promise<boolean> {
    const { userId } = params;
    const selfDeaf = params.selfDeaf === true;
    // Discord-style: deafen implies mute.
    const selfMute = selfDeaf || params.selfMute === true;

    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId) return false;
    if (existing.client !== "minecraft") return false;

    const changed =
      existing.selfMute !== selfMute || existing.selfDeaf !== selfDeaf;

    const next: VoiceState = {
      ...existing,
      selfMute,
      selfDeaf,
      updatedAt: Date.now(),
      joinedAt: existing.joinedAt ?? Date.now(),
    };

    if (changed) {
      await VoiceStateRedis.upsertState(next);
      await VoiceStateService.emitVoiceStateUpdate(
        existing.spaceId ?? null,
        existing.channelId,
        next,
      );
    }

    try {
      // Always apply — even when Redis already matched — so a stale paused
      // producer cannot leave the MC peer silently muted.
      MinecraftVoicePeers.get(String(userId))?.setLocalMuted(
        selfMute || selfDeaf,
      );
    } catch {
      // ignore
    }

    return true;
  }

  static async keepAliveMinecraftVoice(userId: Snowflake): Promise<boolean> {
    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId || existing.client !== "minecraft") return false;

    const touched = await VoiceStateRedis.touchMinecraftState({
      userId,
      spaceId: existing.spaceId ?? null,
      channelId: existing.channelId,
      updatedAt: Date.now(),
    });
    if (!touched) return false;

    await VoiceStateRedis.touchActiveSession(userId);
    await touchVoiceSessionTtls(userId);
    return true;
  }

  static async moveMemberToVoiceChannel(
    spaceId: Snowflake,
    targetUserId: Snowflake,
    channelId: Snowflake,
  ) {
    const existing = await VoiceStateRedis.getState(targetUserId);
    if (!existing?.channelId) return false;
    if (String(existing.spaceId) !== String(spaceId)) return false;
    if (String(existing.channelId) === String(channelId)) return true;

    const hasConnect = await canVoiceConnect({
      spaceId,
      channelId,
      userId: targetUserId,
    });
    if (!hasConnect) return false;

    const voiceEndpoint = this.getVoiceEndpoint();
    if (!voiceEndpoint) return false;

    const oldChannelId = existing.channelId;
    const isMinecraft = existing.client === "minecraft";

    let minecraftUuid: string | null = null;
    if (isMinecraft) {
      minecraftUuid =
        MinecraftVoicePeers.get(String(targetUserId))?.minecraftUuid ?? null;
      if (!minecraftUuid) {
        const location = await getMinecraftVoicePeerLocation(
          String(targetUserId),
        );
        minecraftUuid = location?.minecraftUuid ?? null;
      }
    }

    const moderation = await this.getMemberVoiceModeration(
      spaceId,
      targetUserId,
    );

    const hasSpeak = await canVoiceSpeak({
      spaceId,
      channelId,
      userId: targetUserId,
    });

    const active = await VoiceStateRedis.getActiveSession(targetUserId);
    const sessionId = active?.sessionId ?? existing.sessionId;

    const now = Date.now();
    const next: VoiceState = {
      ...existing,
      channelId,
      spaceMute: moderation.spaceMute || !hasSpeak,
      spaceDeaf: moderation.spaceDeaf,
      sessionId,
      updatedAt: now,
      joinedAt: now,
    };

    await VoiceStateRedis.upsertState(next);

    await VoiceStateService.emitVoiceStateUpdate(spaceId, channelId, next);

    const roomId = voiceScopeKey(spaceId, channelId);

    const oldRoomId = voiceScopeKey(spaceId, oldChannelId);
    await VoiceStateService.publishVoiceKick({
      userId: targetUserId,
      spaceId,
      roomId: oldRoomId,
      sessionId: existing.sessionId,
      reason: "Moved to another voice channel",
    });

    const tokenId = crypto.randomUUID();
    const voiceToken = generateVoiceToken(
      targetUserId.toString(),
      sessionId,
      roomId,
      tokenId,
    );

    await VoiceStateRedis.setActiveSession({
      userId: targetUserId,
      sessionId,
      roomId,
      tokenId,
      updatedAt: Date.now(),
    });

    await createVoiceSession(
      voiceToken,
      targetUserId,
      sessionId,
      roomId,
      undefined,
      tokenId,
    );

    if (isMinecraft) {
      if (!minecraftUuid) {
        logger.warn(
          "Minecraft voice move aborted: peer uuid unavailable",
          { userId: String(targetUserId) },
        );
        await this.kickMemberFromVoice(
          spaceId,
          targetUserId,
          "Minecraft voice peer unavailable",
        );
        return false;
      }

      try {
        await MinecraftVoicePeers.join({
          userId: String(targetUserId),
          minecraftUuid,
          voiceEndpoint,
          voiceToken,
          sessionId,
          roomId,
          spaceId: String(spaceId),
          channelId: String(channelId),
        });

        MinecraftVoicePeers.get(String(targetUserId))?.setLocalMuted(
          next.spaceMute || next.spaceDeaf,
        );

        const audio = await mintMinecraftAudioToken({
          userId: String(targetUserId),
          sessionId,
          minecraftUuid,
        });

        const found = findOnlinePlayer(minecraftUuid);
        const channel = await db.query.channelsTable.findFirst({
          where: eq(channelsTable.id, BigInt(channelId)),
        });
        if (found) {
          for (const minecraftSession of sessionsForBridge(found.bridgeId)) {
            if (minecraftSession.serverId !== found.player.serverId) continue;
            sendToSocket(minecraftSession.socket, {
              op: "dispatch",
              t: "VOICE_RESULT",
              d: {
                action: "join",
                ok: true,
                uuid: minecraftUuid,
                message: channel?.name
                  ? `Moved to #${channel.name}`
                  : "Moved to Mutualzz voice",
                userId: String(targetUserId),
                spaceId: String(spaceId),
                channelId: String(channelId),
                channelName: channel?.name ?? "",
                room: String(channelId),
                roomId,
                audioWsUrl: audio.audioWsUrl,
                audioToken: audio.token,
              },
            });
          }
        }
      } catch (err) {
        logger.error(
          "Failed to rejoin Minecraft voice peer after moderator move",
          { userId: String(targetUserId), err },
        );
        await this.kickMemberFromVoice(
          spaceId,
          targetUserId,
          "Failed to move Minecraft voice session",
        );
        return false;
      }
    } else {
      await emitEvent({
        event: "VoiceServerUpdate",
        user_id: targetUserId,
        data: {
          roomId,
          spaceId,
          channelId,
          voiceEndpoint,
          voiceToken,
          sessionId,
        },
      });
    }

    void VoiceStateService.emitStatesAsUpdates(spaceId, oldChannelId);
    void VoiceStateService.emitStatesAsUpdates(spaceId, channelId);

    return true;
  }

  static async sendRejoinIfNeeded(socket: WebSocket) {
    if (!socket.userId || !socket.sessionId) return;

    const userId = socket.userId;
    const sessionId = socket.sessionId;

    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId) return;

    if (existing.client === "minecraft") {
      void VoiceStateService.streamStatesToSocket(
        socket,
        existing.spaceId,
        existing.channelId,
        socket.userId,
      );
      return;
    }

    const active = await VoiceStateRedis.getActiveSession(userId);
    if (active && active.sessionId !== sessionId) {
      const ownerStillConnected = PresenceBucket.socketsByUserId(
        String(userId),
      ).some((ws) => ws !== socket && ws.sessionId === active.sessionId);

      if (ownerStillConnected) {
        void VoiceStateService.streamStatesToSocket(
          socket,
          existing.spaceId,
          existing.channelId,
          socket.userId,
        );
        return;
      }
    }

    const moderation = await this.getMemberVoiceModeration(
      existing.spaceId,
      userId,
    );

    const isDmVoice = existing.spaceId == null;

    if (isDmVoice) {
      const activeCall = await CallRedis.getByChannel(existing.channelId);
      if (!activeCall || activeCall.status === "ended") {
        await VoiceStateService.kickMemberFromVoice(
          null,
          userId,
          "call ended",
          existing.channelId,
        );
        return;
      }
    }

    const hasSpeak = isDmVoice
      ? true
      : await canVoiceSpeak({
          spaceId: existing.spaceId!,
          channelId: existing.channelId,
          userId: userId,
        });

    existing.spaceMute = moderation.spaceMute || !hasSpeak;
    existing.spaceDeaf = moderation.spaceDeaf;

    existing.sessionId = sessionId;
    existing.updatedAt = Date.now();
    if (!existing.joinedAt) existing.joinedAt = existing.updatedAt;

    if (active && active.sessionId !== sessionId) {
      try {
        await VoiceStateRedis.clearActiveSession(userId, active.tokenId);
        existing.joinedAt = Date.now();
        await VoiceStateService.publishVoiceKick({
          userId,
          spaceId: existing.spaceId,
          roomId: active.roomId,
          sessionId: active.sessionId,
          reason: "superseded",
        });
      } catch (err) {
        logger.warn("Failed to clear active voice session while superseding", {
          userId,
          err,
        });
        return;
      }
    }

    await VoiceStateRedis.upsertState(existing);

    await VoiceStateService.emitVoiceStateUpdate(
      existing.spaceId,
      existing.channelId,
      existing,
    );

    const roomId = voiceScopeKey(existing.spaceId, existing.channelId);
    const issued = await this.issueVoiceServerUpdate(socket, {
      roomId,
      spaceId: existing.spaceId,
      channelId: existing.channelId,
      userId,
      sessionId,
    });
    if (!issued) return;

    void VoiceStateService.streamStatesToSocket(
      socket,
      existing.spaceId,
      existing.channelId,
      socket.userId,
    );
  }

  static async applyMemberVoiceModeration(
    spaceId: Snowflake,
    targetUserId: Snowflake,
    patch: { spaceMute?: boolean | null; spaceDeaf?: boolean | null },
  ) {
    const existing = await VoiceStateRedis.getState(targetUserId);
    if (!existing?.channelId) return;
    if (String(existing.spaceId) !== String(spaceId)) return;

    const moderation = await this.getMemberVoiceModeration(spaceId, targetUserId);
    const hasSpeak = await canVoiceSpeak({
      spaceId,
      channelId: existing.channelId,
      userId: targetUserId,
    });

    existing.spaceMute = moderation.spaceMute || !hasSpeak;
    existing.spaceDeaf = moderation.spaceDeaf;

    existing.updatedAt = Date.now();
    if (!existing.joinedAt) {
      existing.joinedAt = existing.updatedAt;
    }
    await VoiceStateRedis.upsertState(existing);

    await VoiceStateService.publishVoiceModeration({
      userId: targetUserId,
      roomId: voiceScopeKey(existing.spaceId, existing.channelId),
      muted: existing.spaceMute || existing.spaceDeaf,
      deafened: existing.spaceDeaf,
    });

    if (existing.client === "minecraft") {
      await setMinecraftVoicePeerLocalMuted(
        String(targetUserId),
        existing.spaceMute || existing.spaceDeaf,
      );
    }

    await VoiceStateService.emitVoiceStateUpdate(spaceId, existing.channelId, existing);
  }

  private static async rejectVoiceJoin(
    socket: WebSocket,
    userId: Snowflake,
    spaceId: Snowflake | null,
    reason: string,
    preserveExisting = false,
  ) {
    const existing = await VoiceStateRedis.getState(userId);
    if (existing?.channelId) {
      if (preserveExisting) {
        await Send(socket, {
          op: "Dispatch",
          t: "VoiceStateUpdate",
          s: SessionRuntime.nextSequence(socket.sessionId, socket),
          d: existing,
        });
        void VoiceStateService.streamStatesToSocket(
          socket,
          existing.spaceId ?? null,
          existing.channelId,
          userId,
        );
        const ownsExistingSession =
          !!socket.sessionId &&
          String(existing.sessionId) === String(socket.sessionId);
        if (ownsExistingSession && this.getVoiceEndpoint()) {
          await this.issueVoiceServerUpdate(socket, {
            roomId: voiceScopeKey(existing.spaceId, existing.channelId),
            spaceId: existing.spaceId ?? null,
            channelId: existing.channelId,
            userId,
            sessionId: socket.sessionId!,
          });
        }
        return;
      }
      await this.kickMemberFromVoice(
        existing.spaceId,
        userId,
        reason || "Unable to join voice channel",
      );
      return;
    }

    await Send(socket, {
      op: "Dispatch",
      t: "VoiceStateUpdate",
      s: SessionRuntime.nextSequence(socket.sessionId, socket),
      d: {
        userId,
        spaceId,
        channelId: null,
      },
    });
  }

  private static async canJoinDmVoice(
    channelId: Snowflake,
    userId: Snowflake,
  ) {
    const channel = await db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, BigInt(channelId)),
    });
    if (
      !channel ||
      (channel.type !== ChannelType.DM && channel.type !== ChannelType.GroupDM)
    ) {
      return false;
    }

    const recipient = await db.query.channelRecipientsTable.findFirst({
      where: and(
        eq(channelRecipientsTable.channelId, BigInt(channelId)),
        eq(channelRecipientsTable.userId, BigInt(userId)),
        eq(channelRecipientsTable.closed, false),
      ),
    });

    return !!recipient;
  }

  private static async getMemberVoiceModeration(
    spaceId: Snowflake | null,
    userId: Snowflake,
  ) {
    if (!spaceId) return { spaceMute: false, spaceDeaf: false };

    try {
      const moderation = await db.query.voiceModerationTable.findFirst({
        where: and(
          eq(voiceModerationTable.spaceId, BigInt(spaceId)),
          eq(voiceModerationTable.userId, BigInt(userId)),
        ),
      });

      if (!moderation) return { spaceMute: false, spaceDeaf: false };

      return {
        spaceMute: moderation.spaceMute,
        spaceDeaf: moderation.spaceDeaf,
      };
    } catch (err) {
      logger.error("Failed to get moderation for user", err);
      return { spaceMute: false, spaceDeaf: false };
    }
  }

  private static async streamStatesToSocket(
    socket: WebSocket,
    spaceId: Snowflake | null,
    channelId: Snowflake,
    skipUserId?: Snowflake | null,
  ) {
    try {
      const states = await VoiceStateRedis.listChannelStates(
        spaceId,
        channelId,
      );
      if (!states || states.length === 0) return;

      const filtered = skipUserId
        ? states.filter((s) => String(s.userId) !== String(skipUserId))
        : states;

      const chunkSize = VoiceStateService.STREAM_CHUNK_SIZE;
      const pauseMs = VoiceStateService.STREAM_PAUSE_MS;

      for (let i = 0; i < filtered.length; i += chunkSize) {
        const chunk = filtered.slice(i, i + chunkSize);

        for (const state of chunk) {
          try {
            await Send(socket, {
              op: "Dispatch",
              t: "VoiceStateUpdate",
              s: SessionRuntime.nextSequence(socket.sessionId, socket),
              d: state,
            });
          } catch (sendErr) {
            logger.debug("Failed to send streamed VoiceStateUpdate to socket", {
              err: sendErr,
              userId: state.userId,
              channelId,
            });
          }
        }

        // pause briefly to avoid blocking
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    } catch (err) {
      logger.error("Failed to stream voice states to socket", {
        spaceId,
        channelId,
        err,
      });
    }
  }

  static async notifyMemberLeftChannel(
    spaceId: Snowflake | null,
    channelId: Snowflake,
    userId: Snowflake,
  ) {
    await this.emitVoiceStateUpdate(spaceId, channelId, {
      userId,
      spaceId,
      channelId: null,
    });
    void this.emitStatesAsUpdates(spaceId, channelId);
  }

  private static async emitVoiceStateUpdate(
    spaceId: Snowflake | null | undefined,
    routeChannelId: Snowflake | null | undefined,
    data: unknown,
  ) {
    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId ?? null,
      channel_id: spaceId == null ? (routeChannelId ?? null) : null,
      data,
    });
  }

  static async emitChannelVoiceStateSync(
    spaceId: Snowflake | null,
    channelId: Snowflake,
  ) {
    try {
      const states = await VoiceStateRedis.listChannelStates(
        spaceId,
        channelId,
      );
      await emitEvent({
        event: "VoiceStateSync",
        space_id: spaceId,
        channel_id: spaceId == null ? channelId : null,
        data: {
          channelId: String(channelId),
          spaceId: spaceId == null ? null : String(spaceId),
          states,
        },
      });
    } catch (err) {
      logger.error("Failed to emit VoiceStateSync", {
        spaceId,
        channelId,
        err,
      });
    }
  }

  private static async emitStatesAsUpdates(
    spaceId: Snowflake | null,
    channelId: Snowflake,
  ) {
    try {
      const states = await VoiceStateRedis.listChannelStates(
        spaceId,
        channelId,
      );
      if (states.length === 0) {
        if (spaceId == null) {
          await VoiceStateService.emitChannelVoiceStateSync(spaceId, channelId);
        }
        return;
      }

      for (const st of states) {
        try {
          await VoiceStateService.emitVoiceStateUpdate(spaceId, channelId, st);
        } catch (emitErr) {
          logger.debug("Failed to emit per-member VoiceStateUpdate", {
            err: emitErr,
            userId: st.userId,
            channelId,
          });
        }
      }
    } catch (err) {
      logger.error("Failed to emit per-member voice state updates", {
        spaceId,
        channelId,
        err,
      });
    }
  }
}
