import { Logger } from "@mutualzz/logger";
import { redis } from "@mutualzz/util";
import { VoiceStateService } from "../../gateway/voice/VoiceState.service.ts";
import { findOnlinePlayer } from "../OnlinePlayers.ts";
import { sessionsForBridge, sendToSocket } from "../SessionRegistry.ts";
import {
  VoicePeerSession,
  type MinecraftVoiceJoinPayload,
} from "./VoicePeerSession.ts";
import {
  clearMinecraftVoicePeerLocation,
  getMinecraftVoicePeerLocation,
  registerMinecraftVoicePeerLocation,
} from "./audioTokens.ts";
import { INSTANCE_ID } from "../../util/InstanceId.ts";

const logger = new Logger({
  tag: "MinecraftVoicePeers",
  level: (process.env.LOG_LEVEL as "debug" | "info" | undefined) ?? "info",
});

const PEER_CONTROL_CHANNEL = "voice:mc:peer:control";

const notifyMinecraftClientLeave = async (
  minecraftUuid: string,
  reason: "leave" | "kicked",
) => {
  try {
    const found = findOnlinePlayer(minecraftUuid);
    if (!found) return;
    const { bridgeId, player } = found;
    for (const session of sessionsForBridge(bridgeId)) {
      if (session.serverId !== player.serverId) continue;
      sendToSocket(session.socket, {
        op: "dispatch",
        t: "VOICE_RESULT",
        d: {
          action: "leave",
          ok: true,
          uuid: player.uuid,
          name: player.name,
          reason,
          message:
            reason === "kicked"
              ? "Removed from Mutualzz voice"
              : "Left Mutualzz voice",
        },
      });
    }
  } catch (err) {
    logger.debug(`notifyMinecraftClientLeave failed: ${err}`);
  }
};

class MinecraftVoicePeersRegistry {
  private readonly byUserId = new Map<string, VoicePeerSession>();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private controlSubscriberStarted = false;

  constructor() {
    this.heartbeatTimer = setInterval(() => {
      void this.refreshStates().catch((err) =>
        logger.warn(`Minecraft voice heartbeat failed: ${err}`),
      );
    }, 15_000);
    this.heartbeatTimer.unref();
    void this.startControlSubscriber();
  }

  private async startControlSubscriber() {
    if (this.controlSubscriberStarted) return;
    this.controlSubscriberStarted = true;

    try {
      const sub = redis.duplicate();
      sub.on("message", (channel, message) => {
        if (channel !== PEER_CONTROL_CHANNEL) return;
        void this.onControlMessage(message).catch((err) =>
          logger.warn(`Minecraft voice peer control failed: ${err}`),
        );
      });
      await sub.subscribe(PEER_CONTROL_CHANNEL);
    } catch (err) {
      this.controlSubscriberStarted = false;
      logger.warn(`Failed to subscribe to Minecraft voice peer control: ${err}`);
    }
  }

  private async onControlMessage(message: string) {
    let data: {
      action?: string;
      userId?: string;
      reason?: "leave" | "kicked" | "replaced";
      muted?: boolean;
      instanceId?: string;
    };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!data.userId) return;
    if (data.instanceId === INSTANCE_ID) return;

    if (data.action === "moderation") {
      this.byUserId.get(data.userId)?.setLocalMuted(data.muted === true);
      return;
    }

    if (data.action !== "leave") return;

    const session = this.byUserId.get(data.userId);
    if (!session) return;

    this.byUserId.delete(data.userId);
    await clearMinecraftVoicePeerLocation(data.userId).catch(() => undefined);

    if (data.reason === "replaced") {
      session.close("replaced");
      return;
    }

    await session.leave(data.reason === "kicked" ? "kicked" : "leave").catch(
      () => undefined,
    );
    if (data.reason === "kicked") {
      void notifyMinecraftClientLeave(session.minecraftUuid, "kicked");
    }
  }

  private async publishRemoteLeave(
    userId: string,
    reason: "leave" | "kicked" | "replaced",
  ) {
    try {
      await redis.publish(
        PEER_CONTROL_CHANNEL,
        JSON.stringify({
          action: "leave",
          userId,
          reason,
          instanceId: INSTANCE_ID,
        }),
      );
    } catch (err) {
      logger.warn(`Failed to publish Minecraft voice peer leave: ${err}`);
    }
  }

  private async publishRemoteModeration(userId: string, muted: boolean) {
    try {
      await redis.publish(
        PEER_CONTROL_CHANNEL,
        JSON.stringify({
          action: "moderation",
          userId,
          muted,
          instanceId: INSTANCE_ID,
        }),
      );
    } catch (err) {
      logger.warn(`Failed to publish Minecraft voice moderation: ${err}`);
    }
  }

  private async refreshStates() {
    for (const userId of this.byUserId.keys()) {
      const alive = await VoiceStateService.keepAliveMinecraftVoice(userId);
      if (!alive) {
        await this.leave(userId).catch(() => undefined);
      }
    }
  }

  get(userId: string) {
    return this.byUserId.get(userId);
  }

  async join(payload: MinecraftVoiceJoinPayload): Promise<VoicePeerSession> {
    const location = await getMinecraftVoicePeerLocation(payload.userId);
    if (location && location.instanceId !== INSTANCE_ID) {
      await this.publishRemoteLeave(payload.userId, "replaced");
    }

    const existing = this.byUserId.get(payload.userId);
    if (existing) {
      this.byUserId.delete(payload.userId);
      await clearMinecraftVoicePeerLocation(payload.userId).catch(() => undefined);
      existing.close("replaced");
    }

    const session = new VoicePeerSession(payload);
    this.byUserId.set(payload.userId, session);

    try {
      await session.join(payload);
      await registerMinecraftVoicePeerLocation({
        userId: payload.userId,
        sessionId: payload.sessionId,
        minecraftUuid: payload.minecraftUuid,
      });
      logger.debug(
        `Minecraft voice peer joined userId=${payload.userId} uuid=${payload.minecraftUuid}`,
      );
      return session;
    } catch (err) {
      this.byUserId.delete(payload.userId);
      await clearMinecraftVoicePeerLocation(payload.userId).catch(() => undefined);
      session.close();
      throw err;
    }
  }

  async leave(
    userId: string,
    reason: "leave" | "kicked" = "leave",
  ): Promise<boolean> {
    const session = this.byUserId.get(userId);
    if (!session) {
      await this.publishRemoteLeave(userId, reason);
      await clearMinecraftVoicePeerLocation(userId).catch(() => undefined);
      return false;
    }
    const minecraftUuid = session.minecraftUuid;
    this.byUserId.delete(userId);
    await clearMinecraftVoicePeerLocation(userId).catch(() => undefined);
    await session.leave(reason).catch(() => undefined);
    logger.debug(`Minecraft voice peer left userId=${userId} reason=${reason}`);
    void notifyMinecraftClientLeave(minecraftUuid, reason);
    return true;
  }

  async setLocalMuted(userId: string, muted: boolean) {
    this.byUserId.get(userId)?.setLocalMuted(muted);
    await this.publishRemoteModeration(userId, muted);
  }

  has(userId: string) {
    return this.byUserId.has(userId);
  }
}

export const MinecraftVoicePeers = new MinecraftVoicePeersRegistry();

export const setMinecraftVoicePeerLocalMuted = (
  userId: string,
  muted: boolean,
) => MinecraftVoicePeers.setLocalMuted(userId, muted);
