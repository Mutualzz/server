import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { CallService, parseCallCreateBody } from "../call/Call.service";

export async function onCallCreate(this: WebSocket, data: GatewayPayload) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const { channelId, silent, selfMute, selfDeaf } = parseCallCreateBody(
    data.d,
  );
  if (!channelId) return;

  await CallService.createCall(this, channelId, silent, {
    selfMute,
    selfDeaf,
  });
}
