import { GatewayCloseCodes } from "@mutualzz/types";
import { logger } from "../Logger";
import type { WebSocket } from "../util/WebSocket";
import { SessionRuntime } from "../util/SessionRuntime";
import { PresenceService } from "../presence/Presence.service.ts";
import { VoiceStateService } from "../voice/VoiceState.service.ts";
import { touchLastSeen } from "../util/LastSeen.ts";

export async function Close(this: WebSocket, code: number, reason: Buffer) {
  logger.info(
    `closed connection for ${this.userId} (Session: ${this.sessionId}) for reason: ${reason.toString()}, code: ${code}`,
  );

  if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
  if (this.readyTimeout) clearTimeout(this.readyTimeout);

  PresenceService.onSocketClose(this);

  await PresenceService.onDisconnect(this.userId, this.sessionId);
  void touchLastSeen(this.userId);

  if (
    !this.sessionId ||
    !this.userId ||
    code === GatewayCloseCodes.ForceLogout ||
    code === GatewayCloseCodes.InvalidSession
  ) {
    await SessionRuntime.destroy(this.sessionId);
    return;
  }

  await SessionRuntime.detach(this, code);
  VoiceStateService.scheduleLeaveIfSessionStillDetached(
    this.userId,
    this.sessionId,
  );
}
