import type { Snowflake } from "@mutualzz/types";

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
}

export type VoiceStateUpdateBody = {
    spaceId: Snowflake | null;
    channelId: Snowflake | null;
    selfMute?: boolean;
    selfDeaf?: boolean;
};
