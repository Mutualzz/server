import {
  ChannelType,
  GatewayCloseCodes,
  type GatewayPayload,
  type RESTSession,
} from "@mutualzz/types";
import { getUser, prepareReadyData, redis } from "@mutualzz/util";
import { randomUUID } from "crypto";
import { setupListener } from "../Listener";
import { logger } from "../Logger";
import { saveSession } from "../util";
import { clearSessionBuffer } from "../util/SessionEventBuffer";
import { SessionRuntime } from "../util/SessionRuntime";
import { setHeartbeat } from "../util/Heartbeat";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";
import { VoiceStateService } from "@mutualzz/gateway/voice/VoiceState.service.ts";
import { CallService } from "../call/Call.service";

export async function onIdentify(this: WebSocket, data: GatewayPayload) {
  if (this.userId) return;

  clearTimeout(this.readyTimeout);

  const identify = data.d;

  const rawSession = await redis.get(`rest:sessions:${identify.token}`);
  if (!rawSession) {
    logger.error(
      `Invalid token for session ${this.sessionId}`,
    );
    await Send(this, {
      op: "InvalidSession",
      d: false,
    });
    return this.close(GatewayCloseCodes.InvalidSession, "Invalid token");
  }

  const session: RESTSession = JSON.parse(rawSession);

  this.sessionId = randomUUID();

  const user = await getUser(session.userId, true);
  if (!user) {
    logger.error(`User not found for session ${this.sessionId}`);
    await Send(this, {
      op: "InvalidSession",
      d: false,
    });
    return this.close(GatewayCloseCodes.InvalidSession, "Invalid user");
  }

  this.userId = user.id.toString();
  this.sequence = 0;

  this.memberListSubs = this.memberListSubs ?? new Map();
  this.presences = this.presences ?? new Map();
  this.presenceSubs = new Set();

  await clearSessionBuffer(this.sessionId);

  await saveSession({
    sessionId: this.sessionId,
    userId: user.id,
    seq: this.sequence,
  });

  SessionRuntime.register(this);
  setHeartbeat(this);

  await PresenceService.onSocketAuthenticated(this);

  const readyData = await prepareReadyData(user);

  for (const channel of readyData.channels) {
    if (
      channel.type === ChannelType.DM ||
      channel.type === ChannelType.GroupDM
    ) {
      for (const recipientId of channel.recipientIds ?? []) {
        if (String(recipientId) !== this.userId) {
          this.presenceSubs.add(String(recipientId));
        }
      }
    }
  }
  for (const rel of readyData.relationships) {
    const otherId =
      String(rel.userId) === this.userId
        ? String(rel.otherUserId)
        : String(rel.userId);
    this.presenceSubs.add(otherId);
  }

  await Send(this, {
    op: "Dispatch",
    t: "Ready",
    s: SessionRuntime.nextSequence(this.sessionId, this),
    d: {
      ...readyData,
      sessionId: this.sessionId,
      calls: await CallService.listActiveCallsForChannels(
        (readyData.channels ?? [])
          .filter(
            (ch) =>
              ch.type === ChannelType.DM || ch.type === ChannelType.GroupDM,
          )
          .map((ch) => ch.id.toString()),
        this.userId,
      ),
    },
  });

  logger.info(
    `Session authenticated: ${this.sessionId} (user: ${this.userId})`,
  );

  await setupListener.call(this);

  await VoiceStateService.sendRejoinIfNeeded(this);
}
