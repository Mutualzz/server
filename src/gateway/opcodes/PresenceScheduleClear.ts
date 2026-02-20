// backend/src/gateway/PresenceScheduleClear.ts
import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/PresenceService";

export async function onPresenceScheduleClear(
    this: WebSocket,
    data: GatewayPayload,
) {
    if (!this.userId) {
        this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
        return;
    }

    await PresenceService.clearScheduledStatus(this.userId);
}
