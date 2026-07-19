import {
  CALL_SOLO_TIMEOUT_MS,
  ChannelType,
  MessageType,
  type APICall,
  type CallRespondAction,
  type Snowflake,
  type VoiceClient,
} from "@mutualzz/types";
import {
  channelRecipientsTable,
  channelsTable,
  db,
  messagesTable,
} from "@mutualzz/database";
import { emitEvent, normalizeJSON } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import { messageFlags } from "@mutualzz/bitfield";
import { Logger } from "@mutualzz/logger";
import { Snowflake as SnowflakeUtil } from "../../util/Snowflake";
import { createSystemMessage, getSystemUser } from "../../util/systemUser";
import { getUser, setChannelLastMessageId } from "../../util/Helpers";
import {
  cancelCallPushNotifications,
  sendCallPushNotifications,
} from "../../util/PushNotifications";
import type { WebSocket } from "../util/WebSocket";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import { VoiceStateRedis } from "../voice/VoiceState.redis";
import { VoiceStateService } from "../voice/VoiceState.service";
import { CallRedis } from "./Call.redis";

const logger = new Logger({ tag: "CallService" });

const SOLO_EPHEMERAL =
  "You can't stay in this channel that long — bandwidth doesn't grow on trees.";

function formatCallDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours} hour${hours === 1 ? "" : "s"}, ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  if (minutes > 0) {
    if (seconds > 0 && minutes < 10) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}, ${seconds} second${seconds === 1 ? "" : "s"}`;
    }
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function voiceClientFromUa(socket: WebSocket): VoiceClient | undefined {
  const ua = socket.userAgent?.toLowerCase() ?? "";
  if (ua.includes("mutualzz-mobile") || ua.includes("expo")) return "mobile";
  if (ua.includes("electron")) return "desktop";
  if (ua) return "web";
  return undefined;
}

async function resolveJoinMute(
  userId: Snowflake,
  requested?: { selfMute?: boolean; selfDeaf?: boolean },
) {
  const existing = await VoiceStateRedis.getState(userId);
  return {
    selfMute:
      requested?.selfMute === true
        ? true
        : requested?.selfMute === false
          ? false
          : (existing?.selfMute ?? false),
    selfDeaf:
      requested?.selfDeaf === true
        ? true
        : requested?.selfDeaf === false
          ? false
          : (existing?.selfDeaf ?? false),
  };
}

export class CallService {
  static async createCall(
    socket: WebSocket,
    channelId: Snowflake,
    silent = false,
    mute?: { selfMute?: boolean; selfDeaf?: boolean },
  ) {
    if (!socket.userId || !socket.sessionId) return;

    const userId = socket.userId;
    const canJoin = await this.canJoinDmCall(channelId, userId);
    if (!canJoin) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to start call" },
      });
      return;
    }

    const joinMute = await resolveJoinMute(userId, mute);

    if (await this.isOnMinecraftVoice(userId)) {
      await Send(socket, {
        op: "System",
        d: { message: "Leave Minecraft voice before starting a call" },
      });
      return;
    }

    const existing = await CallRedis.getByChannel(channelId);
    if (existing) {
      const occupants = await VoiceStateRedis.listChannelStates(
        null,
        channelId,
      );
      if (occupants.length === 0) {
        await this.endCall(existing, {
          reason: "empty",
          persistEnded: false,
          missed: false,
        });
        const still = await CallRedis.getByChannel(channelId);
        if (still && String(still.id) === String(existing.id)) {
          await CallRedis.delete(still);
        }
      } else {
        await this.joinExistingCall(socket, existing, channelId, joinMute);
        return;
      }
    }

    const recipients = await this.listOpenRecipientIds(channelId);
    const ringing = silent
      ? []
      : recipients.filter((id) => String(id) !== String(userId));

    if (!silent && ringing.length === 0) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to start call" },
      });
      return;
    }

    const now = Date.now();
    const call: APICall = {
      id: SnowflakeUtil.generate(),
      channelId: String(channelId),
      initiatorId: String(userId),
      status: silent || ringing.length === 0 ? "active" : "ringing",
      silent,
      ringing: ringing.map(String),
      accepted: [String(userId)],
      createdAt: now,
      aloneSince: now,
      soloTimeoutMs: CALL_SOLO_TIMEOUT_MS,
      connected: false,
    };

    const created = await CallRedis.create(call);
    if (!created) {
      const raced = await CallRedis.getByChannel(channelId);
      if (raced) {
        await this.joinExistingCall(socket, raced, channelId, joinMute);
      }
      return;
    }

    const cancelUser = await CallRedis.consumeCancelIntent(channelId);
    if (cancelUser && cancelUser === String(userId)) {
      await this.endCall(call, {
        reason: "cancelled",
        persistEnded: false,
        missed: false,
      });
      return;
    }

    await VoiceStateService.handleVoiceStateUpdate(socket, {
      spaceId: null,
      channelId,
      selfMute: joinMute.selfMute,
      selfDeaf: joinMute.selfDeaf,
      client: voiceClientFromUa(socket),
    });

    if (!(await this.isUserInDmVoice(userId, channelId))) {
      await this.endCall(call, {
        reason: "failed",
        persistEnded: false,
        missed: false,
      });
      await this.kickChannelOccupants(channelId);
      await Send(socket, {
        op: "System",
        d: { message: "Unable to start call" },
      });
      return;
    }

    const live = await CallRedis.get(call.id);
    if (!live || live.status === "ended") {
      await this.kickChannelOccupants(channelId);
      await Send(socket, {
        op: "System",
        d: { message: "Unable to start call" },
      });
      return;
    }

    await emitEvent({
      event: "CallCreate",
      channel_id: String(channelId),
      data: live,
    });

    if (!silent) {
      await Promise.all(
        live.ringing.map((ringUserId) =>
          emitEvent({
            event: "CallCreate",
            user_id: ringUserId,
            data: live,
          }),
        ),
      );

      void this.sendRingPush(live).catch((err) => {
        logger.warn("Failed to send call push", err);
      });
    }
  }

  static async respond(
    socket: WebSocket,
    callId: Snowflake,
    action: CallRespondAction,
    mute?: { selfMute?: boolean; selfDeaf?: boolean },
  ) {
    if (!socket.userId || !socket.sessionId) return;

    const userId = String(socket.userId);
    let call = await CallRedis.get(callId);
    if (!call && String(callId).startsWith("pending:")) {
      const channelId = String(callId).slice("pending:".length);
      call = await CallRedis.getByChannel(channelId);
      if ((!call || call.status === "ended") && action === "cancel") {
        await CallRedis.setCancelIntent(channelId, userId);
        return;
      }
    }
    if (!call || call.status === "ended") {
      if (action === "cancel") {
        const channelId = String(callId).startsWith("pending:")
          ? String(callId).slice("pending:".length)
          : null;
        if (channelId) {
          await CallRedis.setCancelIntent(channelId, userId);
        }
      }
      return;
    }

    if (action === "accept") {
      await CallRedis.clearCancelIntent(call.channelId);
      await this.accept(socket, call, userId, mute);
      return;
    }

    if (action === "decline") {
      await this.decline(call, userId);
      return;
    }

    if (String(call.initiatorId) !== userId) return;
    await this.cancel(call);
  }

  static async onVoiceOccupancyChanged(channelId: Snowflake) {
    const call = await CallRedis.getByChannel(channelId);
    if (!call || call.status === "ended") return;

    let states = await VoiceStateRedis.listChannelStates(null, channelId);
    let count = states.length;

    if (count >= 2) {
      states = await VoiceStateRedis.listChannelStates(null, channelId);
      count = states.length;
    }

    let acceptedChanged = false;
    const ringingCleared: string[] = [];
    for (const state of states) {
      const uid = String(state.userId);
      if (!call.accepted.includes(uid)) {
        call.accepted.push(uid);
        acceptedChanged = true;
      }
      if (call.ringing.includes(uid)) {
        call.ringing = call.ringing.filter((id) => id !== uid);
        await CallRedis.removeFromRinging(call.id, uid);
        ringingCleared.push(uid);
        acceptedChanged = true;
      }
    }

    if (ringingCleared.length > 0) {
      void cancelCallPushNotifications({
        callId: call.id,
        channelId: call.channelId,
        recipientIds: ringingCleared,
      }).catch((err) => {
        logger.warn("Failed to cancel call push", err);
      });
    }

    if (count === 0) {
      await this.endEmptyCall(call);
      return;
    }

    if (count === 1) {
      const refreshAloneSince =
        call.aloneSince == null || call.connected || acceptedChanged;
      if (refreshAloneSince) {
        call.aloneSince = Date.now();
        await CallRedis.save(call);
        await emitEvent({
          event: "CallUpdate",
          channel_id: call.channelId,
          data: call,
        });
      }
      return;
    }

    if (
      call.aloneSince != null ||
      call.status === "ringing" ||
      acceptedChanged ||
      !call.connected
    ) {
      call.aloneSince = null;
      call.status = "active";
      call.connected = true;
      await CallRedis.save(call);
      await emitEvent({
        event: "CallUpdate",
        channel_id: call.channelId,
        data: call,
      });
    }
  }

  static async sweepSoloTimeouts() {
    const callIds = await CallRedis.listActiveCallIds();
    const now = Date.now();

    for (const callId of callIds) {
      const call = await CallRedis.get(callId);
      if (!call) {
        await CallRedis.dropActive(callId);
        continue;
      }
      if (call.status === "ended") {
        await CallRedis.delete(call);
        continue;
      }

      const states = await VoiceStateRedis.listChannelStates(
        null,
        call.channelId,
      );

      if (states.length === 0) {
        if (now - call.createdAt < 2_000) continue;
        await this.endEmptyCall(call);
        continue;
      }

      if (states.length === 1) {
        if (call.aloneSince == null) {
          call.aloneSince = now;
          await CallRedis.save(call);
          continue;
        }
        if (now - call.aloneSince < call.soloTimeoutMs) continue;

        const lone = states[0];
        const loneUserId = String(lone.userId);
        const unansweredRing =
          call.status === "ringing" ||
          (call.accepted.length <= 1 && call.ringing.length > 0);

        if (!unansweredRing) {
          await this.sendEphemeral(call.channelId, loneUserId, SOLO_EPHEMERAL);
        }

        await this.endCall(call, {
          reason: unansweredRing ? "ring_timeout" : "solo_timeout",
          persistEnded:
            !unansweredRing && (!!call.connected || call.accepted.length > 1),
          missed: !call.silent && unansweredRing && call.accepted.length <= 1,
        });
        continue;
      }

      if (
        call.aloneSince != null ||
        call.status === "ringing" ||
        !call.connected
      ) {
        call.aloneSince = null;
        call.status = "active";
        call.connected = true;
        await CallRedis.save(call);
        await emitEvent({
          event: "CallUpdate",
          channel_id: call.channelId,
          data: call,
        });
      }
    }
  }

  static async listActiveCallsForChannels(
    channelIds: Snowflake[],
    _userId?: Snowflake,
  ) {
    return CallRedis.listCallsForChannels(channelIds);
  }

  static async listActiveCallsForUser(userId: Snowflake) {
    const callIds = await CallRedis.listActiveCallIds();
    const calls: APICall[] = [];
    const uid = String(userId);

    for (const callId of callIds) {
      const call = await CallRedis.get(callId);
      if (!call || call.status === "ended") {
        if (!call) await CallRedis.dropActive(callId);
        continue;
      }

      const isParticipant =
        call.accepted.includes(uid) ||
        call.ringing.includes(uid) ||
        String(call.initiatorId) === uid;

      if (isParticipant) {
        calls.push(call);
        continue;
      }

      if (
        call.status === "active" &&
        (await this.canJoinDmCall(call.channelId, uid))
      ) {
        calls.push(call);
      }
    }

    return calls;
  }

  static async detachUserFromCall(channelId: Snowflake, userId: Snowflake) {
    const call = await CallRedis.getByChannel(channelId);
    if (!call || call.status === "ended") return;

    const uid = String(userId);
    const inRinging = call.ringing.includes(uid);
    const inAccepted = call.accepted.includes(uid);
    const isInitiator = String(call.initiatorId) === uid;
    if (!inRinging && !inAccepted && !isInitiator) return;

    const channel = await db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, BigInt(call.channelId)),
    });
    const isDm = channel?.type === ChannelType.DM;

    if (isDm && inRinging && !isInitiator) {
      await this.decline(call, uid);
      return;
    }

    const states = await VoiceStateRedis.listChannelStates(null, channelId);
    const othersInVoice = states.filter((s) => String(s.userId) !== uid);

    if (isDm && othersInVoice.length === 0) {
      await this.cancel(call);
      return;
    }

    if (inRinging) {
      call.ringing = call.ringing.filter((id) => id !== uid);
      await CallRedis.removeFromRinging(call.id, uid);
    }
    if (inAccepted) {
      call.accepted = call.accepted.filter((id) => id !== uid);
    }

    if (call.ringing.length === 0 && call.accepted.length === 0) {
      await this.endCall(call, {
        reason: "empty",
        persistEnded: false,
        missed: false,
      });
      return;
    }

    if (
      othersInVoice.length <= 1 &&
      (call.aloneSince == null || call.connected)
    ) {
      call.aloneSince = Date.now();
    }

    await CallRedis.save(call);
    await emitEvent({
      event: "CallUpdate",
      channel_id: call.channelId,
      data: call,
    });
    await emitEvent({
      event: "CallUpdate",
      user_id: uid,
      data: call,
    });
  }

  static async notifyUserOfActiveCall(channelId: Snowflake, userId: Snowflake) {
    const call = await CallRedis.getByChannel(channelId);
    if (!call || call.status === "ended") return;

    const uid = String(userId);
    if (
      call.status === "ringing" &&
      !call.silent &&
      !call.ringing.includes(uid) &&
      String(call.initiatorId) !== uid
    ) {
      call.ringing = [...call.ringing, uid];
      await CallRedis.addToRinging(call.id, uid);
      await CallRedis.save(call);
      await emitEvent({
        event: "CallUpdate",
        channel_id: call.channelId,
        data: call,
      });
      void this.sendRingPush({
        ...call,
        ringing: [uid],
      }).catch((err) => {
        logger.warn("Failed to send call push", err);
      });
    }

    await emitEvent({
      event: "CallCreate",
      user_id: uid,
      data: call,
    });
  }

  static async endCallForChannel(
    channelId: Snowflake,
    reason = "channel_deleted",
  ) {
    const call = await CallRedis.getByChannel(channelId);
    if (!call || call.status === "ended") return;
    await this.endCall(call, {
      reason,
      persistEnded: !!call.connected || call.accepted.length > 1,
      missed: false,
    });
  }

  private static async joinExistingCall(
    socket: WebSocket,
    call: APICall,
    channelId: Snowflake,
    joinMute: { selfMute: boolean; selfDeaf: boolean },
  ) {
    const latest = await CallRedis.get(call.id);
    if (!latest || latest.status === "ended") {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    await VoiceStateService.handleVoiceStateUpdate(socket, {
      spaceId: null,
      channelId,
      selfMute: joinMute.selfMute,
      selfDeaf: joinMute.selfDeaf,
      client: voiceClientFromUa(socket),
    });

    if (!(await this.isUserInDmVoice(socket.userId!, channelId))) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    const live = await CallRedis.get(call.id);
    if (!live || live.status === "ended") {
      await VoiceStateService.kickMemberFromVoice(
        null,
        socket.userId!,
        "call ended",
        channelId,
      );
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    await Send(socket, {
      op: "Dispatch",
      t: "CallCreate",
      s: SessionRuntime.nextSequence(socket.sessionId, socket),
      d: live,
    });

    void cancelCallPushNotifications({
      callId: live.id,
      channelId: live.channelId,
      recipientIds: [String(socket.userId)],
    }).catch((err) => {
      logger.warn("Failed to cancel call push", err);
    });
  }

  private static async isUserInDmVoice(
    userId: Snowflake,
    channelId: Snowflake,
  ) {
    const joined = await VoiceStateRedis.getState(userId);
    return (
      !!joined?.channelId &&
      String(joined.channelId) === String(channelId) &&
      joined.spaceId == null
    );
  }

  private static async accept(
    socket: WebSocket,
    call: APICall,
    userId: string,
    mute?: { selfMute?: boolean; selfDeaf?: boolean },
  ) {
    if (await this.isOnMinecraftVoice(userId)) {
      await Send(socket, {
        op: "System",
        d: { message: "Leave Minecraft voice before joining a call" },
      });
      return;
    }

    const canJoin = await this.canJoinDmCall(call.channelId, userId);
    if (!canJoin) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    if (
      !call.ringing.includes(userId) &&
      !call.accepted.includes(userId) &&
      String(call.initiatorId) !== userId
    ) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    const joinMute = await resolveJoinMute(userId, mute);

    await VoiceStateService.handleVoiceStateUpdate(socket, {
      spaceId: null,
      channelId: call.channelId,
      selfMute: joinMute.selfMute,
      selfDeaf: joinMute.selfDeaf,
      client: voiceClientFromUa(socket),
    });

    const joined = await VoiceStateRedis.getState(userId);
    if (
      !joined?.channelId ||
      String(joined.channelId) !== String(call.channelId) ||
      joined.spaceId != null
    ) {
      await Send(socket, {
        op: "System",
        d: { message: "Unable to join call" },
      });
      return;
    }

    const latest = await CallRedis.get(call.id);
    if (!latest || latest.status === "ended") {
      await VoiceStateService.kickMemberFromVoice(
        null,
        userId,
        "call ended",
        call.channelId,
      );
      return;
    }

    latest.ringing = latest.ringing.filter((id) => id !== userId);
    if (!latest.accepted.includes(userId)) {
      latest.accepted.push(userId);
    }
    latest.status = latest.ringing.length > 0 ? "ringing" : "active";
    const occupants = await VoiceStateRedis.listChannelStates(
      null,
      latest.channelId,
    );
    latest.aloneSince = occupants.length <= 1 ? Date.now() : null;
    if (occupants.length >= 2) {
      latest.connected = true;
    }

    await CallRedis.removeFromRinging(latest.id, userId);
    await CallRedis.save(latest);

    await emitEvent({
      event: "CallUpdate",
      channel_id: latest.channelId,
      data: latest,
    });

    void cancelCallPushNotifications({
      callId: latest.id,
      channelId: latest.channelId,
      recipientIds: [userId],
    }).catch((err) => {
      logger.warn("Failed to cancel call push", err);
    });
  }

  private static async decline(call: APICall, userId: string) {
    const inRinging = call.ringing.includes(userId);
    const inAccepted = call.accepted.includes(userId);

    if (!inRinging && !inAccepted) return;

    if (inRinging) {
      call.ringing = call.ringing.filter((id) => id !== userId);
      await CallRedis.removeFromRinging(call.id, userId);
    }

    if (inAccepted && !inRinging) {
      call.accepted = call.accepted.filter((id) => id !== userId);
      await VoiceStateService.kickMemberFromVoice(
        null,
        userId,
        "left call",
        call.channelId,
      );
      void cancelCallPushNotifications({
        callId: call.id,
        channelId: call.channelId,
        recipientIds: [userId],
      }).catch((err) => {
        logger.warn("Failed to cancel call push", err);
      });

      if (call.ringing.length === 0 && call.accepted.length === 0) {
        await this.endCall(call, {
          reason: "empty",
          persistEnded: !!call.connected,
          missed: false,
        });
        return;
      }

      const states = await VoiceStateRedis.listChannelStates(
        null,
        call.channelId,
      );
      if (states.length <= 1 && (call.aloneSince == null || call.connected)) {
        call.aloneSince = Date.now();
      }
      await CallRedis.save(call);
      await emitEvent({
        event: "CallUpdate",
        channel_id: call.channelId,
        data: call,
      });
      await emitEvent({
        event: "CallUpdate",
        user_id: userId,
        data: call,
      });
      return;
    }

    const channel = await db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, BigInt(call.channelId)),
    });
    const isDm = channel?.type === ChannelType.DM;

    if (isDm || (call.ringing.length === 0 && call.accepted.length <= 1)) {
      await CallRedis.save(call);
      await this.endCall(call, {
        reason: "declined",
        persistEnded: false,
        missed: !call.silent,
      });
      return;
    }

    await CallRedis.save(call);
    await emitEvent({
      event: "CallUpdate",
      channel_id: call.channelId,
      data: call,
    });
    await emitEvent({
      event: "CallUpdate",
      user_id: userId,
      data: call,
    });
    void cancelCallPushNotifications({
      callId: call.id,
      channelId: call.channelId,
      recipientIds: [userId],
    }).catch((err) => {
      logger.warn("Failed to cancel call push", err);
    });
  }

  private static async cancel(call: APICall) {
    const states = await VoiceStateRedis.listChannelStates(
      null,
      call.channelId,
    );

    if (states.length >= 2) {
      const ringingRecipients = [...call.ringing];
      await CallRedis.clearRinging(call);
      call.ringing = [];
      call.status = "active";
      call.connected = true;
      await CallRedis.save(call);
      await emitEvent({
        event: "CallUpdate",
        channel_id: call.channelId,
        data: call,
      });
      for (const recipientId of ringingRecipients) {
        await emitEvent({
          event: "CallUpdate",
          user_id: recipientId,
          data: call,
        });
      }
      void cancelCallPushNotifications({
        callId: call.id,
        channelId: call.channelId,
        recipientIds: ringingRecipients,
      }).catch((err) => {
        logger.warn("Failed to cancel call push", err);
      });
      return;
    }

    const cancelledWhileRinging = call.status === "ringing";
    await this.endCall(call, {
      reason: cancelledWhileRinging ? "cancelled" : "empty",
      persistEnded:
        !cancelledWhileRinging &&
        (!!call.connected || call.accepted.length > 1),
      missed: false,
    });
  }

  private static async kickChannelOccupants(channelId: Snowflake) {
    const states = await VoiceStateRedis.listChannelStates(null, channelId);
    for (const state of states) {
      await VoiceStateService.kickMemberFromVoice(
        null,
        state.userId,
        "call ended",
        channelId,
      );
    }
  }

  private static async endEmptyCall(call: APICall) {
    const emptyWhileRinging = call.status === "ringing";
    await this.endCall(call, {
      reason: emptyWhileRinging ? "cancelled" : "empty",
      persistEnded:
        !emptyWhileRinging && (!!call.connected || call.accepted.length > 1),
      missed: false,
    });
  }

  private static async endCall(
    call: APICall,
    options: {
      reason: string;
      persistEnded: boolean;
      missed: boolean;
    },
  ) {
    const claimed = await CallRedis.claimEnd(call.id);
    if (!claimed) return;

    const current = await CallRedis.get(call.id);
    if (!current || current.status === "ended") {
      await CallRedis.releaseEndClaim(call.id);
      return;
    }

    if (options.reason === "empty") {
      const occupants = await VoiceStateRedis.listChannelStates(
        null,
        current.channelId,
      );
      if (occupants.length > 0) {
        await CallRedis.releaseEndClaim(current.id);
        return;
      }
    }

    const ringingRecipients = [...current.ringing];
    const acceptedRecipients = [...current.accepted];
    current.status = "ended";
    await CallRedis.clearRinging({ ...current, ringing: ringingRecipients });
    current.ringing = [];
    await CallRedis.delete(current);

    const participantIds = new Set<string>([
      String(current.initiatorId),
      ...acceptedRecipients.map(String),
      ...ringingRecipients.map(String),
    ]);

    await emitEvent({
      event: "CallDelete",
      channel_id: current.channelId,
      data: { ...current, reason: options.reason },
    });

    await Promise.all(
      [...participantIds].map((participantId) =>
        emitEvent({
          event: "CallDelete",
          user_id: participantId,
          data: { ...current, reason: options.reason },
        }),
      ),
    );

    await this.kickChannelOccupants(current.channelId);

    void VoiceStateService.emitChannelVoiceStateSync(null, current.channelId);

    void cancelCallPushNotifications({
      callId: current.id,
      channelId: current.channelId,
      recipientIds: [...participantIds],
    }).catch((err) => {
      logger.warn("Failed to cancel call push", err);
    });

    if (options.missed) {
      const initiator = await getUser(current.initiatorId);
      const displayName =
        initiator?.globalName || initiator?.username || "Someone";
      await this.persistCallMessage(
        current.channelId,
        `Missed call from ${displayName}`,
        MessageType.CallMissed,
      );
    } else if (options.persistEnded) {
      const lasted = formatCallDuration(Date.now() - current.createdAt);
      await this.persistCallMessage(
        current.channelId,
        `Call ended — lasted ${lasted}`,
        MessageType.CallEnded,
      );
    }
  }

  private static async persistCallMessage(
    channelId: Snowflake,
    content: string,
    type: MessageType.CallMissed | MessageType.CallEnded,
  ) {
    try {
      const systemUser = await getSystemUser();
      if (!systemUser) {
        logger.warn("Failed to persist call message: missing system user");
        return;
      }

      const messageId = BigInt(SnowflakeUtil.generate());

      const inserted = await db
        .insert(messagesTable)
        .values({
          id: messageId,
          authorId: BigInt(systemUser.id),
          channelId: BigInt(channelId),
          content,
          type,
          flags: 0n,
          embeds: [],
          codedLinks: [],
          attachments: [],
          expressionIds: [],
          mentions: [],
        })
        .returning()
        .then((rows) => rows[0]);

      if (!inserted) return;

      await setChannelLastMessageId(String(channelId), messageId.toString());

      await emitEvent({
        event: "MessageCreate",
        channel_id: String(channelId),
        data: {
          id: messageId.toString(),
          type,
          content,
          flags: 0n,
          edited: false,
          embeds: [],
          codedLinks: [],
          attachments: [],
          mentions: [],
          nonce: null,
          spaceId: null,
          channelId: String(channelId),
          authorId: String(systemUser.id),
          author: systemUser,
          createdAt: inserted.createdAt,
          updatedAt: inserted.updatedAt,
        },
      });
    } catch (err) {
      logger.warn("Failed to persist call message", err);
    }
  }

  private static async sendEphemeral(
    channelId: Snowflake,
    userId: Snowflake,
    content: string,
  ) {
    try {
      const sysMsg = await createSystemMessage(
        channelId,
        content,
        messageFlags.Ephemeral,
      );
      await emitEvent({
        event: "MessageCreate",
        user_id: String(userId),
        data: sysMsg,
      });
    } catch (err) {
      logger.warn("Failed to send call ephemeral", err);
    }
  }

  private static async sendRingPush(call: APICall) {
    const live = await CallRedis.get(call.id);
    if (!live || live.status === "ended" || live.ringing.length === 0) return;

    const channel = await db.query.channelsTable.findFirst({
      where: eq(channelsTable.id, BigInt(live.channelId)),
    });
    if (!channel) return;
    if (
      channel.type !== ChannelType.DM &&
      channel.type !== ChannelType.GroupDM
    ) {
      return;
    }

    const caller = await getUser(live.initiatorId);
    const callerName = caller?.globalName || caller?.username || "Someone";

    await sendCallPushNotifications({
      callId: live.id,
      channelId: live.channelId,
      channelType: channel.type,
      callerId: live.initiatorId,
      callerName,
      recipientIds: live.ringing,
    });
  }

  private static async isOnMinecraftVoice(userId: Snowflake) {
    const state = await VoiceStateRedis.getState(userId);
    return !!state?.channelId && state.client === "minecraft";
  }

  private static async canJoinDmCall(channelId: Snowflake, userId: Snowflake) {
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

  private static async listOpenRecipientIds(channelId: Snowflake) {
    const rows = await db
      .select({ userId: channelRecipientsTable.userId })
      .from(channelRecipientsTable)
      .where(
        and(
          eq(channelRecipientsTable.channelId, BigInt(channelId)),
          eq(channelRecipientsTable.closed, false),
        ),
      );

    return rows.map((row) => row.userId.toString());
  }
}

export function parseCallCreateBody(data: unknown) {
  const body = normalizeJSON<{
    channelId?: Snowflake;
    silent?: boolean;
    selfMute?: boolean;
    selfDeaf?: boolean;
  }>(data ?? {});
  return {
    channelId: body.channelId ? String(body.channelId) : null,
    silent: body.silent === true,
    selfMute: typeof body.selfMute === "boolean" ? body.selfMute : undefined,
    selfDeaf: typeof body.selfDeaf === "boolean" ? body.selfDeaf : undefined,
  };
}

export function parseCallRespondBody(data: unknown) {
  const body = normalizeJSON<{
    callId?: Snowflake;
    action?: CallRespondAction;
    selfMute?: boolean;
    selfDeaf?: boolean;
  }>(data ?? {});
  const action = body.action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    return {
      callId: null,
      action: null,
      selfMute: undefined,
      selfDeaf: undefined,
    };
  }
  return {
    callId: body.callId ? String(body.callId) : null,
    action,
    selfMute: typeof body.selfMute === "boolean" ? body.selfMute : undefined,
    selfDeaf: typeof body.selfDeaf === "boolean" ? body.selfDeaf : undefined,
  };
}
