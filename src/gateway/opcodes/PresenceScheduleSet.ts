import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/PresenceService";

type Payload = {
    status: "online" | "idle" | "dnd" | "invisible";
    durationMs: number;
};

export async function onPresenceScheduleSet(
    this: WebSocket,
    data: GatewayPayload,
) {
    if (!this.userId) {
        this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
        return;
    }

    const body = (data.d ?? {}) as Partial<Payload>;
    const status = body.status;
    const durationMs = Number(body.durationMs);

    if (
        status !== "online" &&
        status !== "idle" &&
        status !== "dnd" &&
        status !== "invisible"
    )
        return;

    if (!Number.isFinite(durationMs)) return;

    const clampedDurationMs = Math.max(
        0,
        Math.min(durationMs, 7 * 24 * 60 * 60_000),
    );

    await PresenceService.setScheduledStatus(this.userId, {
        status,
        durationMs: clampedDurationMs,
    });
}
