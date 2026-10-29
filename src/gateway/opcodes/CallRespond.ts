import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import { gatewayCallRespondPayload } from "@mutualzz/validators";
import type { WebSocket } from "../util/WebSocket";
import { CallService } from "../call/Call.service";

export async function onCallRespond(this: WebSocket, data: GatewayPayload) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const parsed = gatewayCallRespondPayload.safeParse(data.d);
  if (!parsed.success) return;

  const { callId, action, selfMute, selfDeaf } = parsed.data;

  await CallService.respond(this, callId, action, { selfMute, selfDeaf });
}
