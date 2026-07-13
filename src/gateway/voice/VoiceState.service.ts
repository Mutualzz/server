import crypto from "crypto";
import { type Snowflake } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { Send } from "../util/Send";
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
import { db, voiceModerationTable } from "@mutualzz/database";
import { INSTANCE_ID } from "../../util/InstanceId.ts";

export class VoiceStateService {
  static readonly instanceId: string = INSTANCE_ID;

  private static readonly STREAM_CHUNK_SIZE = 25;
  private static readonly STREAM_PAUSE_MS = 10;

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
      s: socket.sequence++,
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
        return;
      }
      if (previous) {
        try {
          const payload = JSON.stringify({
            userId: String(userId),
            spaceId: previous.spaceId,
            reason: "left",
            instanceId: this.instanceId,
          });
          await redis.publish("voice:control:kick", payload);
        } catch (err) {
          logger.error("Failed to publish voice leave control event", err);
        }

        const active = await VoiceStateRedis.getActiveSession(userId);
        if (active) {
          try {
            await VoiceStateRedis.clearActiveSession(userId, active.tokenId);
          } catch {
            /* empty */
          }
        }

        await VoiceStateRedis.removeState({
          userId,
          spaceId: previous.spaceId ?? null,
          channelId: previous.channelId,
        });

        await emitEvent({
          space_id: previous.spaceId ?? null,
          event: "VoiceStateUpdate",
          data: {
            userId,
            spaceId: previous.spaceId ?? null,
            channelId: null,
          },
        });

        void VoiceStateService.emitStatesAsUpdates(
          previous.spaceId ?? null,
          previous.channelId!,
        );
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
        );
        return;
      }
    }

    const isFirstJoin = previous == null || previous.channelId == null;
    const isMove =
      previous != null &&
      previous.channelId != null &&
      (previous.spaceId !== spaceId ||
        previous.channelId !== requestedChannelId);

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

    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId,
      data: next,
    });

    if (isFirstJoin || isMove || shouldSupersede || refreshRtcRequested) {
      const roomId = voiceScopeKey(spaceId, requestedChannelId);

      const issued = await this.issueVoiceServerUpdate(socket, {
        roomId,
        spaceId,
        channelId: requestedChannelId,
        userId,
        sessionId,
      });
      if (!issued) return;

      void VoiceStateService.streamStatesToSocket(
        socket,
        spaceId,
        requestedChannelId,
        socket.userId,
      );

      void VoiceStateService.emitStatesAsUpdates(spaceId, requestedChannelId);
    } else {
      await VoiceStateRedis.touchActiveSession(userId);
      await touchVoiceSessionTtls(userId);
    }
  }

  static async kickMemberFromVoice(
    spaceId: Snowflake,
    targetUserId: Snowflake,
    reason = "Kicked from voice",
  ) {
    const existing = await VoiceStateRedis.getState(targetUserId);
    if (!existing?.channelId) return false;
    if (existing.spaceId !== spaceId) return false;

    if (existing.client === "minecraft") {
      const { MinecraftVoicePeers } =
        await import("../../minecraft/voice/MinecraftVoicePeers.ts");
      const { revokeMinecraftAudioTokenForUser } =
        await import("../../minecraft/voice/audioTokens.ts");
      await revokeMinecraftAudioTokenForUser(String(targetUserId));
      await MinecraftVoicePeers.leave(String(targetUserId), "kicked");
    }

    try {
      const payload = JSON.stringify({
        userId: String(targetUserId),
        spaceId: existing.spaceId,
        reason,
        instanceId: this.instanceId,
      });

      await redis.publish("voice:control:kick", payload);
    } catch (err) {
      logger.error("Failed to publish voice kick control event", err);
    }

    const active = await VoiceStateRedis.getActiveSession(targetUserId);
    if (active) {
      try {
        await VoiceStateRedis.clearActiveSession(targetUserId, active.tokenId);
      } catch {
        /* empty */
      }
    }

    await VoiceStateRedis.removeState({
      userId: targetUserId,
      spaceId,
      channelId: existing.channelId,
    });

    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId,
      data: {
        userId: targetUserId,
        spaceId,
        channelId: null,
      },
    });

    void VoiceStateService.emitStatesAsUpdates(spaceId, existing.channelId);

    return true;
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
        const payload = JSON.stringify({
          userId: String(userId),
          spaceId: previous?.spaceId ?? spaceId,
          // App only skips auto-rejoin for the exact token "superseded".
          reason: "superseded",
          instanceId: this.instanceId,
        });
        await redis.publish("voice:control:kick", payload);
      } catch (err) {
        logger.warn(
          "Failed to supersede prior voice session for Minecraft join",
          { userId, err },
        );
      }
    }

    if (
      previous?.channelId &&
      (previous.spaceId !== spaceId ||
        String(previous.channelId) !== String(channelId))
    ) {
      await VoiceStateRedis.removeState({
        userId,
        spaceId: previous.spaceId ?? null,
        channelId: previous.channelId,
      });
      await emitEvent({
        event: "VoiceStateUpdate",
        space_id: previous.spaceId ?? null,
        data: {
          userId,
          spaceId: previous.spaceId ?? null,
          channelId: null,
        },
      });
      if (previous.channelId) {
        void VoiceStateService.emitStatesAsUpdates(
          previous.spaceId ?? null,
          previous.channelId,
        );
      }
    }

    await VoiceStateRedis.upsertState(next);
    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId,
      data: next,
    });
    void VoiceStateService.emitStatesAsUpdates(spaceId, channelId);

    const voiceEndpoint = this.getVoiceEndpoint();
    if (!voiceEndpoint) {
      return {
        ok: false,
        code: "voice_unavailable",
        message: "Voice server is not configured",
      };
    }

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

  /** Leave voice if the active session is a Minecraft client. */
  static async leaveFromMinecraft(userId: Snowflake): Promise<boolean> {
    const existing = await VoiceStateRedis.getState(userId);
    if (!existing?.channelId || !existing.spaceId) {
      const { MinecraftVoicePeers } =
        await import("../../minecraft/voice/MinecraftVoicePeers.ts");
      const { revokeMinecraftAudioTokenForUser } =
        await import("../../minecraft/voice/audioTokens.ts");
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
      await emitEvent({
        event: "VoiceStateUpdate",
        space_id: existing.spaceId ?? null,
        data: next,
      });
    }

    try {
      const { MinecraftVoicePeers } =
        await import("../../minecraft/voice/MinecraftVoicePeers.ts");
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

  static async moveMemberToVoiceChannel(
    spaceId: Snowflake,
    targetUserId: Snowflake,
    channelId: Snowflake,
  ) {
    const existing = await VoiceStateRedis.getState(targetUserId);
    if (!existing?.channelId) return false;
    if (existing.spaceId !== spaceId) return false;
    if (String(existing.channelId) === String(channelId)) return true;

    const hasConnect = await canVoiceConnect({
      spaceId,
      channelId,
      userId: targetUserId,
    });
    if (!hasConnect) return false;

    const oldChannelId = existing.channelId;

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

    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId,
      data: next,
    });

    const roomId = voiceScopeKey(spaceId, channelId);
    const voiceEndpoint = this.getVoiceEndpoint();
    if (!voiceEndpoint) return false;

    const oldRoomId = voiceScopeKey(spaceId, oldChannelId);
    try {
      const payload = JSON.stringify({
        userId: String(targetUserId),
        spaceId,
        roomId: oldRoomId,
        reason: "Moved to another voice channel",
        instanceId: this.instanceId,
      });
      await redis.publish("voice:control:kick", payload);
    } catch (err) {
      logger.error("Failed to publish voice move kick control event", err);
    }

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
      } catch (err) {
        logger.warn("Failed to clear active voice session while superseding", {
          userId,
          err,
        });
        return;
      }
    }

    await VoiceStateRedis.upsertState(existing);

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
    if (existing.spaceId !== spaceId) return;

    if (patch.spaceMute != null) existing.spaceMute = patch.spaceMute;
    if (patch.spaceDeaf != null) existing.spaceDeaf = patch.spaceDeaf;

    existing.updatedAt = Date.now();
    if (!existing.joinedAt) {
      existing.joinedAt = existing.updatedAt;
    }
    await VoiceStateRedis.upsertState(existing);

    try {
      const current = await db.query.voiceModerationTable.findFirst({
        where: and(
          eq(voiceModerationTable.spaceId, BigInt(spaceId)),
          eq(voiceModerationTable.userId, BigInt(targetUserId)),
        ),
      });

      if (current) {
        await db
          .update(voiceModerationTable)
          .set({
            spaceMute: patch.spaceMute ?? current.spaceMute,
            spaceDeaf: patch.spaceDeaf ?? current.spaceDeaf,
          })
          .where(
            and(
              eq(voiceModerationTable.spaceId, BigInt(spaceId)),
              eq(voiceModerationTable.userId, BigInt(targetUserId)),
            ),
          );
      } else if (patch.spaceMute || patch.spaceDeaf) {
        await db.insert(voiceModerationTable).values({
          spaceId: BigInt(spaceId),
          userId: BigInt(targetUserId),
          spaceMute: patch.spaceMute ?? false,
          spaceDeaf: patch.spaceDeaf ?? false,
        });
      }
    } catch (err) {
      logger.error("Failed to persist voice moderation", err);
    }

    await emitEvent({
      event: "VoiceStateUpdate",
      space_id: spaceId,
      data: existing,
    });
  }

  private static async rejectVoiceJoin(
    socket: WebSocket,
    userId: Snowflake,
    spaceId: Snowflake | null,
    _reason: string,
  ) {
    await Send(socket, {
      op: "Dispatch",
      t: "VoiceStateUpdate",
      s: socket.sequence++,
      d: {
        userId,
        spaceId,
        channelId: null,
      },
    });
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
              s: socket.sequence++,
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

  private static async emitStatesAsUpdates(
    spaceId: Snowflake | null,
    channelId: Snowflake,
  ) {
    try {
      const states = await VoiceStateRedis.listChannelStates(
        spaceId,
        channelId,
      );
      if (states.length === 0) return;

      for (const st of states) {
        try {
          await emitEvent({
            event: "VoiceStateUpdate",
            space_id: spaceId,
            data: st,
          });
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
