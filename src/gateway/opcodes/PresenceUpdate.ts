import type { GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { PresenceService } from "../presence/PresenceService";

export async function onPresenceUpdate(this: WebSocket, data: GatewayPayload) {
    const presence = data?.d?.presence;
    await PresenceService.handleUpdate(this, presence);
}
