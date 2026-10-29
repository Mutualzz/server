import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import { gatewayCustomStatusScheduleSetPayload } from "@mutualzz/validators";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";
import { sanitizeActivityEmoji } from "../presence/Presence.validator.ts";

export async function onCustomStatusScheduleSet(
  this: WebSocket,
  data: GatewayPayload,
) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const parsed = gatewayCustomStatusScheduleSetPayload.safeParse(data.d);
  if (!parsed.success) return;

  const { text, emoji, durationMs } = parsed.data;

  await PresenceService.setScheduledCustomStatus(this.userId, {
    text,
    emoji: sanitizeActivityEmoji(emoji) ?? null,
    durationMs,
  });
}
