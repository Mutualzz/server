import type { GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/Presence.service.ts";

export async function onPresenceUpdate(this: WebSocket, data: GatewayPayload) {
    const presence = data?.d;
    await PresenceService.handleUpdate(this, presence);
}
