import { VoiceStateSweeper } from "./VoiceState.sweeper.ts";
import { VoiceStateService } from "./VoiceState.service.ts";
import { CallSweeper } from "../call/Call.sweeper.ts";

export function initVoiceState() {
  VoiceStateSweeper.start(VoiceStateService.instanceId);
  CallSweeper.start(VoiceStateService.instanceId);
}
