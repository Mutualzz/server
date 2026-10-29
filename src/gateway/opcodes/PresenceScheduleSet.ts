import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import { gatewayPresenceScheduleSetPayload } from "@mutualzz/validators";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";

export async function onPresenceScheduleSet(
  this: WebSocket,
  data: GatewayPayload,
) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const parsed = gatewayPresenceScheduleSetPayload.safeParse(data.d);
  if (!parsed.success) return;

  await PresenceService.setScheduledStatus(this.userId, parsed.data);
}
