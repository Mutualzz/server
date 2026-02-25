export const VOICE_STATE_TTL_SECONDS = 90;
export const VOICE_LAST_TTL_SECONDS = 10 * 60;

export const VOICE_EXP_ZSET_KEY = "voice:exp";
export const VOICE_SWEEP_LOCK_KEY = "voice:sweeper:lock";

export const VOICE_SWEEP_EVERY_MS = 5_000;
export const VOICE_SWEEP_LOCK_TTL_MS = 8_000;
export const VOICE_SWEEP_BATCH_SIZE = 200;
