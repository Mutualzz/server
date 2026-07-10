import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";

export async function onCustomStatusScheduleClear(this: WebSocket) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  await PresenceService.clearScheduledCustomStatus(this.userId);
}
