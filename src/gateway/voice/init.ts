import { VoiceStateSweeper } from "./VoiceState.sweeper.ts";
import { VoiceStateService } from "./VoiceState.service.ts";

export function initVoiceState() {
    VoiceStateSweeper.start(VoiceStateService.instanceId);
}
