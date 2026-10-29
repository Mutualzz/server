import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import { gatewayCallCreatePayload } from "@mutualzz/validators";
import type { WebSocket } from "../util/WebSocket";
import { CallService } from "../call/Call.service";

export async function onCallCreate(this: WebSocket, data: GatewayPayload) {
  if (!this.userId) {
    this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
    return;
  }

  const parsed = gatewayCallCreatePayload.safeParse(data.d);
  if (!parsed.success) return;

  const { channelId, silent, selfMute, selfDeaf } = parsed.data;

  await CallService.createCall(this, channelId, silent === true, {
    selfMute,
    selfDeaf,
  });
}
