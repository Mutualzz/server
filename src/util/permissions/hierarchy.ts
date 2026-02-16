import type { APIRole, Snowflake } from "@mutualzz/types";

export const topRolePosition = (roles: APIRole[]): number => {
    let max = 0;
    for (const role of roles) if (role.position > max) max = role.position;
    return max;
};

interface CanActOnMemberOptions {
    actorId: Snowflake;
    actorTopPosition: number;
    targetId: Snowflake;
    targetTopPosition: number;
    spaceOwnerId: Snowflake;
}

export const canActOnMember = ({
    actorId,
    actorTopPosition,
    targetId,
    targetTopPosition,
    spaceOwnerId,
}: CanActOnMemberOptions) => {
    if (targetId === spaceOwnerId) return false;
    if (actorId === targetId) return false;
    if (actorId === spaceOwnerId) return true;

    return actorTopPosition > targetTopPosition;
};
