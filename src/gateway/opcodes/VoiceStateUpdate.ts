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
    const channelId = body.channelId ?? null;
    const spaceId = body.spaceId ?? null;

    // leave
    if (!channelId) {
        await VoiceStateService.handleVoiceStateUpdate(this, {
            spaceId,
            channelId: null,
            selfMute: body.selfMute === true,
            selfDeaf: body.selfDeaf === true,
        });
        return;
    }

    // join DM or space voice
    await VoiceStateService.handleVoiceStateUpdate(this, {
        spaceId,
        channelId,
        selfMute: body.selfMute === true,
        selfDeaf: body.selfDeaf === true,
    });
}
