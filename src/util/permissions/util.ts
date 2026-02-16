import {
    type APIChannel,
    type APISpace,
    type APISpaceMember,
    ChannelType,
} from "@mutualzz/types";
import {
    permissionFlags,
    resolveBaseBits,
    resolveEffectiveChannelBits,
} from "@mutualzz/permissions";

export type RequireMode = "All" | "Any";

export function getMemberRoleIdsIdsOnly(member: APISpaceMember): string[] {
    return (member.roles ?? [])
        .map((mr) => mr.roleId)
        .filter(Boolean) as string[];
}

export function computeBaseBitsFromSpace(
    space: APISpace,
    member: APISpaceMember,
): {
    baseBits: bigint;
    memberRoleIds: string[];
} {
    const memberRoleIds = getMemberRoleIdsIdsOnly(member);

    const roles = (space.roles ?? []).map((r) => ({
        id: String(r.id),
        permissions: r.permissions,
    }));

    const baseBits = resolveBaseBits(String(space.id), roles, memberRoleIds);
    return { baseBits, memberRoleIds };
}

export function filterVisibleChannelsForUser(
    space: APISpace,
    userId: bigint,
): APIChannel[] {
    const member = (space.members ?? []).find(
        (m) => BigInt(m.userId) === userId,
    );
    if (!member) return [];

    if (BigInt(space.ownerId) === userId) return space.channels ?? [];

    const channels = space.channels ?? [];
    if (channels.length === 0) return [];

    const byId = new Map<string, APIChannel>();
    for (const channel of channels) byId.set(String(channel.id), channel);

    const { baseBits, memberRoleIds } = computeBaseBitsFromSpace(space, member);

    if (
        (baseBits & permissionFlags.Administrator) ===
        permissionFlags.Administrator
    ) {
        return channels;
    }

    const canView = (channel: APIChannel): boolean => {
        const parent = channel.parentId
            ? byId.get(String(channel.parentId))
            : null;

        const effectiveBits = resolveEffectiveChannelBits({
            baseBits,
            userId: String(userId),
            everyoneRoleId: String(space.id), // @everyone == space.id
            memberRoleIds,
            parentOverwrites: parent?.overwrites ?? null,
            channelOverwrites: channel.overwrites ?? null,
        });

        return (
            (effectiveBits & permissionFlags.ViewChannel) ===
            permissionFlags.ViewChannel
        );
    };

    const visibleNonCategories = channels.filter(
        (channel) => channel.type !== ChannelType.Category && canView(channel),
    );

    const visibleParentIds = new Set(
        visibleNonCategories
            .map((c) => c.parentId)
            .filter((id): id is string => Boolean(id))
            .map(String),
    );

    const visibleCategories = channels.filter(
        (c) =>
            c.type === ChannelType.Category &&
            visibleParentIds.has(String(c.id)),
    );

    const sortPos = (a: APIChannel, b: APIChannel) =>
        (a.position ?? 0) - (b.position ?? 0);

    visibleCategories.sort(sortPos);
    visibleNonCategories.sort(sortPos);

    return [...visibleCategories, ...visibleNonCategories];
}
