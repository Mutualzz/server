import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { CallService, parseCallRespondBody } from "../call/Call.service";

export async function onCallRespond(this: WebSocket, data: GatewayPayload) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const { callId, action, selfMute, selfDeaf } = parseCallRespondBody(data.d);
  if (!callId || !action) return;

  await CallService.respond(this, callId, action, { selfMute, selfDeaf });
}
