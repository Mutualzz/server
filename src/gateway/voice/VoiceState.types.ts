import type { Snowflake, VoiceClient } from "@mutualzz/types";

export interface VoiceState {
    userId: Snowflake;
    spaceId: Snowflake | null;
    channelId: Snowflake | null;

    selfMute: boolean;
    selfDeaf: boolean;

    spaceMute: boolean;
    spaceDeaf: boolean;

    sessionId: string;
    updatedAt: number;

    client?: VoiceClient;
}

export type VoiceStateUpdateBody = {
    spaceId: Snowflake | null;
    channelId: Snowflake | null;
    selfMute?: boolean;
    selfDeaf?: boolean;
    /** Request fresh voice server credentials (e.g. after RTC disconnect). */
    refreshRtc?: boolean;
    client?: VoiceClient;
};
