import { Logger } from "@mutualzz/logger";
import {
  VoicePeerSession,
  type MinecraftVoiceJoinPayload,
} from "./VoicePeerSession.ts";
import {
  clearMinecraftVoicePeerLocation,
  registerMinecraftVoicePeerLocation,
} from "./audioTokens.ts";

const logger = new Logger({
  tag: "MinecraftVoicePeers",
  level: (process.env.LOG_LEVEL as "debug" | "info" | undefined) ?? "info",
});

const notifyMinecraftClientLeave = async (
  minecraftUuid: string,
  reason: "leave" | "kicked",
) => {
  try {
    const { findOnlinePlayer } = await import("../OnlinePlayers.ts");
    const { sessionsForBridge, sendToSocket } = await import(
      "../SessionRegistry.ts"
    );
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

  get(userId: string) {
    return this.byUserId.get(userId);
  }

  async join(payload: MinecraftVoiceJoinPayload): Promise<VoicePeerSession> {
    const existing = this.byUserId.get(payload.userId);
    if (existing) {
      await existing.leave().catch(() => undefined);
      this.byUserId.delete(payload.userId);
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

  has(userId: string) {
    return this.byUserId.has(userId);
  }
}

export const MinecraftVoicePeers = new MinecraftVoicePeersRegistry();
