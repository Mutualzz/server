import type { GatewayPayload } from "@mutualzz/types";
import { GatewayCloseCodes } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { VoiceStateService } from "../voice/VoiceState.service";
import { gatewayVoiceStateUpdatePayload } from "@mutualzz/validators";

export async function onVoiceStateUpdate(
    this: WebSocket,
    data: GatewayPayload,
) {
    if (!this.userId) {
        this.close(GatewayCloseCodes.NotAuthenticated, "Not authenticated");
        return;
    }

    const parsed = gatewayVoiceStateUpdatePayload.safeParse(data.d ?? {});
    if (!parsed.success) return;

    const body = parsed.data;
    const channelId = body.channelId ?? null;
    const spaceId = body.spaceId ?? null;
    const client = body.client;

    // leave
    if (!channelId) {
        await VoiceStateService.handleVoiceStateUpdate(this, {
            spaceId,
            channelId: null,
            selfMute: body.selfMute === true,
            selfDeaf: body.selfDeaf === true,
            refreshRtc: body.refreshRtc === true,
            client,
        });
        return;
    }

    // join DMChannel or space voice
    await VoiceStateService.handleVoiceStateUpdate(this, {
        spaceId,
        channelId,
        selfMute: body.selfMute === true,
        selfDeaf: body.selfDeaf === true,
        refreshRtc: body.refreshRtc === true,
        client,
    });
}
