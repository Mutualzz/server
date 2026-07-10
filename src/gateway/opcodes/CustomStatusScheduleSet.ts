import type { GatewayPayload, PresenceActivityEmoji } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";
import { MAX_STR } from "../presence/Presence.validator.ts";

interface Payload {
  text: string;
  emoji?: PresenceActivityEmoji | null;
  durationMs: number;
}

export async function onCustomStatusScheduleSet(
  this: WebSocket,
  data: GatewayPayload,
) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const body = (data.d ?? {}) as Partial<Payload>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const emoji = body.emoji ?? null;
  const durationMs = Number(body.durationMs);

  if (!text && !emoji) return;
  if (!Number.isFinite(durationMs)) return;

  const clampedDurationMs = Math.max(
    0,
    Math.min(durationMs, 7 * 24 * 60 * 60_000),
  );

  await PresenceService.setScheduledCustomStatus(this.userId, {
    text: text.slice(0, MAX_STR),
    emoji,
    durationMs: clampedDurationMs,
  });
}
