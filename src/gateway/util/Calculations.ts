import type { MemberListRange, WebSocket } from "../util/WebSocket.ts";
import { Send } from "../util/Send.ts";
import {
    channelPermissionOverwritesTable,
    channelsTable,
    db,
    rolesTable,
    spaceMembersTable,
} from "@mutualzz/database";
import { and, eq } from "drizzle-orm";
import { hasAny, permissionFlags, resolveEffectiveChannelBits, } from "@mutualzz/permissions";
import { arrayPartition, execNormalizedMany, listenEvent, murmur, } from "@mutualzz/util";
import type { APIMemberRole, APISpaceMember, PresencePayload, Snowflake, } from "@mutualzz/types";
import { PresenceService } from "../presence/Presence.service.ts";

type OverwriteLike = {
    roleId?: string | null;
    userId?: string | null;
    allow: bigint;
    deny: bigint;
};

export function normalizeRange(range: MemberListRange): {
    start: number;
    end: number;
    limit: number;
} {
    if (!Array.isArray(range) || range.length !== 2)
        throw new Error("range is not a valid array");

    const start = Math.max(0, Number(range[0]) || 0);
    const end = Math.max(start, Number(range[1]) || start);
    const limit = end - start + 1;

    return { start, end, limit };
}

export async function getEveryonePermissions(spaceId: Snowflake) {
    const perms = await db
        .select({ permissions: rolesTable.permissions })
        .from(rolesTable)
        .where(eq(rolesTable.id, BigInt(spaceId)))
        .limit(1)
        .then((res) => res[0]);

    return perms != null ? perms.permissions : 0n;
}

export async function getChannelOverwrites(
    spaceId: Snowflake,
    channelId: Snowflake,
): Promise<OverwriteLike[]> {
    const rows = await db
        .select({
            roleId: channelPermissionOverwritesTable.roleId,
            userId: channelPermissionOverwritesTable.userId,
            allow: channelPermissionOverwritesTable.allow,
            deny: channelPermissionOverwritesTable.deny,
        })
        .from(channelPermissionOverwritesTable)
        .where(
            and(
                eq(channelPermissionOverwritesTable.spaceId, BigInt(spaceId)),
                eq(
                    channelPermissionOverwritesTable.channelId,
                    BigInt(channelId),
                ),
            ),
        );

    return rows.map((r) => ({
        roleId: r.roleId != null ? r.roleId.toString() : null,
        userId: r.userId != null ? r.userId.toString() : null,
        allow: r.allow ?? 0n,
        deny: r.deny ?? 0n,
    }));
}

export async function getParentOverwrites(
    spaceId: Snowflake,
    channelId: Snowflake,
): Promise<OverwriteLike[] | null> {
    const parent = await db
        .select({ parentId: channelsTable.parentId })
        .from(channelsTable)
        .where(
            and(
                eq(channelsTable.spaceId, BigInt(spaceId)),
                eq(channelsTable.id, BigInt(channelId)),
            ),
        )
        .limit(1)
        .then((res) => res[0]);

    const { parentId } = parent;
    if (parentId == null) return null;

    return getChannelOverwrites(spaceId, parentId.toString());
}

export function computeListIdFromOverwrites(opts: {
    parentOverwrites?: OverwriteLike[] | null;
    channelOverwrites?: OverwriteLike[] | null;
}): string {
    const { parentOverwrites, channelOverwrites } = opts;

    const view = permissionFlags.ViewChannel;
    const parts: string[] = [];

    const add = (
        prefix: "p" | "c",
        overwrites: OverwriteLike[] | null | undefined,
    ) => {
        if (!overwrites?.length) return;

        for (const ow of overwrites) {
            const { allow, deny, roleId, userId } = ow;

            const key =
                roleId != null
                    ? `r:${roleId}`
                    : userId != null
                      ? `u:${userId}`
                      : "x";

            if ((allow & view) !== 0n) parts.push(`${prefix}:a:${key}`);
            if ((deny & view) !== 0n) parts.push(`${prefix}:d:${key}`);
        }
    };

    add("p", parentOverwrites);
    add("c", channelOverwrites);

    if (!parts.length) return "everyone";

    return murmur(parts.sort().join(","));
}

export function computeMemberBaseBits(
    member: APISpaceMember,
    everyonePerms: bigint,
    spaceId: Snowflake,
): bigint {
    let bits = 0n;
    bits |= everyonePerms;

    const roles = member.roles ?? [];
    for (const mr of roles) {
        const { roleId } = mr;
        if (!roleId || roleId === spaceId) continue;

        const perms = BigInt(mr.role?.permissions ?? 0n);
        bits |= perms;
    }

    return bits;
}

export function computeMemberRoleIds(
    member: APISpaceMember,
    spaceId: Snowflake,
): string[] {
    const roles = member.roles ?? [];
    return roles.map((r) => r.roleId).filter((id) => id !== spaceId);
}

export function canViewChannel(opts: {
    member: APISpaceMember;
    spaceId: Snowflake;
    channelOverwrites: OverwriteLike[];
    parentOverwrites: OverwriteLike[] | null;
    everyonePerms: bigint;
}): boolean {
    const {
        member,
        spaceId,
        channelOverwrites,
        parentOverwrites,
        everyonePerms,
    } = opts;

    const memberRoleIds = computeMemberRoleIds(member, spaceId);
    const baseBits = computeMemberBaseBits(member, everyonePerms, spaceId);

    const bits = resolveEffectiveChannelBits({
        baseBits,
        userId: member.userId,
        everyoneRoleId: spaceId,
        memberRoleIds,
        parentOverwrites,
        channelOverwrites,
    });

    return hasAny(bits, permissionFlags.ViewChannel);
}

export function offlineLike(presence: PresencePayload | null): boolean {
    const status = presence?.status ?? "offline";
    return status === "offline" || status === "invisible";
}

export async function attachPresence(member: APISpaceMember): Promise<
    APISpaceMember & {
        presence?: PresencePayload;
    }
> {
    const presence = await PresenceService.get(member.userId);

    return {
        ...member,
        presence:
            presence ??
            ({
                status: "offline",
                activities: [],
                device: "web",
                updatedAt: 0,
            } satisfies PresencePayload),
    };
}

export async function getMembers(
    spaceId: Snowflake,
    range: MemberListRange,
    channelOverwrites: OverwriteLike[],
    parentOverwrites: OverwriteLike[] | null,
    everyonePerms: bigint,
) {
    const { start, end, limit } = normalizeRange(range);

    let members = await execNormalizedMany<APISpaceMember>(
        db.query.spaceMembersTable.findMany({
            where: eq(spaceMembersTable.spaceId, BigInt(spaceId)),
            with: {
                user: {
                    columns: {
                        hash: false,
                        dateOfBirth: false,
                        previousAvatars: false,
                        email: false,
                    },
                },
                roles: {
                    with: {
                        role: true,
                    },
                },
            },
            offset: start,
            limit,
        }),
    );

    if (!members?.length) {
        return {
            items: [],
            groups: [],
            range: [start, end],
            members: [],
        };
    }

    // Filter members by ViewChannel
    members = members.filter((m) =>
        canViewChannel({
            member: m,
            spaceId,
            channelOverwrites,
            parentOverwrites,
            everyonePerms,
        }),
    );

    if (!members.length) {
        return {
            items: [],
            groups: [],
            range: [start, end],
            members: [],
        };
    }

    const groups: any[] = [];
    const items: any[] = [];

    const membersWithPresence = await Promise.all(members.map(attachPresence));

    let onlineMembers = membersWithPresence.filter(
        (m) => !offlineLike(m.presence ?? null),
    );

    const offlineMembers = membersWithPresence.filter((m) =>
        offlineLike(m.presence ?? null),
    );

    const memberRoles = [
        ...new Map(
            onlineMembers
                .flatMap((m) => m.roles ?? [])
                .map(
                    (role) =>
                        [role.roleId, role] as unknown as [
                            string,
                            APIMemberRole,
                        ],
                ),
        ).values(),
    ] as APIMemberRole[];

    const hoistedRoles = memberRoles
        .filter((r) => r.roleId !== spaceId && !!r.role?.hoist)
        .sort((a, b) => (b.role?.position ?? 0) - (a.role?.position ?? 0));

    const emitRoleGroup = (roleId: string, groupName: string) => {
        const [roleMembers, remaining] = arrayPartition(
            onlineMembers,
            (m) => !!m.roles?.find((r) => r.roleId === roleId),
        );

        if (!roleMembers.length) return;

        const group = {
            count: roleMembers.length,
            id: roleId,
            name: groupName,
        };

        items.push({ group });
        groups.push(group);

        for (const member of roleMembers) {
            const roles =
                member.roles?.filter((x) => x.roleId !== spaceId) ?? [];

            items.push({
                member: {
                    ...member,
                    roles,
                    user: member.user,
                },
            });
        }

        onlineMembers = remaining;
    };

    for (const r of hoistedRoles)
        emitRoleGroup(r.roleId, r.role?.name ?? r.roleId ?? "unknown");

    if (onlineMembers.length) {
        const group = {
            count: onlineMembers.length,
            id: "online",
            name: "Online",
        };
        items.push({ group });
        groups.push(group);

        for (const member of onlineMembers) {
            const roles =
                member.roles?.filter((x) => x.roleId !== spaceId) ?? [];

            items.push({
                member: {
                    ...member,
                    roles,
                    user: member.user,
                },
            });
        }
    }

    if (offlineMembers.length) {
        const group = {
            count: offlineMembers.length,
            id: "offline",
            name: "Offline",
        };
        items.push({ group });
        groups.push(group);

        for (const member of offlineMembers) {
            const roles =
                member.roles?.filter((x) => x.roleId !== spaceId) ?? [];

            items.push({
                member: {
                    ...member,
                    roles,
                    user: member.user,
                },
            });
        }
    }

    return {
        items,
        groups,
        range: [start, end],
        members: items
            .map((x) => ("member" in x ? x.member : undefined))
            .filter(Boolean),
    };
}

export async function subscribeToMemberEvents(
    this: WebSocket,
    userId: Snowflake,
) {
    if (this.events[userId]) return false;
    if (this.memberEvents[userId]) return false;

    this.memberEvents[userId] = await listenEvent(
        userId,
        (opts) => opts?.acknowledge?.(),
        this.listenOptions,
    );

    return true;
}

export async function getMemberCount(spaceId: Snowflake): Promise<number> {
    return db.query.spaceMembersTable
        .findMany({
            where: eq(spaceMembersTable.spaceId, BigInt(spaceId)),
            columns: { userId: true },
        })
        .then((rows) => rows.length)
        .catch(() => 0);
}

export function computeVisibleUserIds(
    ops: Array<{ members: any[] }>,
): Set<string> {
    const out = new Set<string>();
    for (const op of ops) {
        for (const m of op.members ?? []) {
            const uid = m?.user?.id ?? m?.userId;
            if (uid != null) out.add(String(uid));
        }
    }
    return out;
}

export async function resyncMemberListWindows(
    this: WebSocket,
    spaceIdOrSubKey: Snowflake,
) {
    if (!this.memberListSubs || this.memberListSubs.size === 0) return;

    let spaceId: string;
    let channelId: string | null = null;
    let listId: string | null = null;

    const parts = spaceIdOrSubKey.split(":");
    if (parts.length === 3) [spaceId, channelId, listId] = parts;
    else spaceId = spaceIdOrSubKey;

    const subs = [...this.memberListSubs.values()].filter((sub) => {
        if (sub.spaceId !== spaceId) return false;
        if (channelId && sub.channelId !== channelId) return false;
        return !(listId && sub.listId !== listId);
    });

    if (!subs.length) return;

    const memberCount = await getMemberCount(spaceId);
    const everyonePerms = await getEveryonePermissions(spaceId);

    for (const sub of subs) {
        const channelOverwrites = await getChannelOverwrites(
            spaceId,
            sub.channelId,
        );
        const parentOverwrites = await getParentOverwrites(
            spaceId,
            sub.channelId,
        );

        const ops = await Promise.all(
            sub.ranges.map((range) =>
                getMembers(
                    spaceId,
                    range,
                    channelOverwrites,
                    parentOverwrites,
                    everyonePerms,
                ),
            ),
        );

        const groupsMap = new Map<string, any>();
        for (const group of ops.flatMap((x) => x.groups))
            groupsMap.set(group.id, group);
        const groups = [...groupsMap.values()];

        const computedSubKey = `${sub.spaceId}:${sub.channelId}:${sub.listId}`;
        const visibleUserIds = computeVisibleUserIds(ops);

        this.presences = this.presences ?? new Map();
        this.presences.set(computedSubKey, visibleUserIds);

        await Send(this, {
            op: "Dispatch",
            s: this.sequence++,
            t: "SpaceMemberListUpdate",
            d: {
                ops: ops.map((x) => ({
                    items: x.items,
                    op: "SYNC",
                    range: x.range,
                })),
                memberCount,
                id: sub.listId,
                spaceId,
                groups,
            },
        });
    }
}
