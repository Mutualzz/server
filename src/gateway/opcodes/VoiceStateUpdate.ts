import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import type { VoiceStateUpdateBody } from "../voice/VoiceState.types";
import { VoiceStateService } from "../voice/VoiceState.service";
import { normalizeJSON } from "@mutualzz/util";

export async function onVoiceStateUpdate(
    this: WebSocket,
    data: GatewayPayload,
) {
    if (!this.userId) {
        this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
        return;
    }

    const body = normalizeJSON<Partial<VoiceStateUpdateBody>>(data.d ?? {});
    if (!body.spaceId) return;

    const selfMute = body.selfMute === true;
    const selfDeaf = body.selfDeaf === true;

    await VoiceStateService.handleVoiceStateUpdate(this, {
        spaceId: body.spaceId,
        channelId: body.channelId ?? null,
        selfMute,
        selfDeaf,
    });
}
