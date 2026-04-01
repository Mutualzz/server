import type { Snowflake } from "@mutualzz/types";

export function stateKey(userId: Snowflake) {
    return `voice:state:${userId}`;
}

export function lastKey(userId: Snowflake) {
    return `voice:last:${userId}`;
}

export function voiceScopeKey(
    spaceId: Snowflake | null | undefined,
    channelId: Snowflake,
) {
    return spaceId
        ? `voice:space:${spaceId}:channel:${channelId}`
        : `voice:channel:${channelId}`;
}

export function membersKey(spaceId: Snowflake, channelId: Snowflake) {
    return `voice:space:${spaceId}:channel:${channelId}:members`;
}
