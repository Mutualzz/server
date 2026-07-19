import { CallSweeper } from "./Call.sweeper";
import { VoiceStateService } from "../voice/VoiceState.service";

export function initCallState() {
  CallSweeper.start(VoiceStateService.instanceId);
}
