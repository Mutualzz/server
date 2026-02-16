import { db, spaceMembersTable } from "@mutualzz/database";
import { logger } from "@mutualzz/gateway/Logger";
import { Send } from "@mutualzz/gateway/util";
import type {
    APIMemberRole,
    APISpaceMember,
    GatewayPayload,
} from "@mutualzz/types";
import {
    arrayPartition,
    execNormalizedMany,
    getSpace,
    listenEvent,
} from "@mutualzz/util";
import { eq } from "drizzle-orm";
import type { WebSocket } from "../util/WebSocket";

type MemberListRange = [number, number]; // [start, end] inclusive

function normalizeRange(range: MemberListRange): {
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

async function getMembers(spaceId: string, range: MemberListRange) {
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

    if (!members || !members.length) {
        return {
            items: [],
            groups: [],
            range: [start, end],
            members: [],
        };
    }

    const groups: any[] = [];
    const items: any[] = [];

    const member_roles = [
        ...new Map(
            members
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

    const hoistedRoles = member_roles
        .filter((r: any) => r.roleId !== spaceId && !!r.role?.hoist)
        .sort(
            (a: any, b: any) =>
                (b.role?.position ?? 0) - (a.role?.position ?? 0),
        );

    const emitRoleGroup = (groupName: string, roleId: string) => {
        const [roleMembers, remaining] = arrayPartition(
            members,
            (m) => !!m.roles?.find((r) => r.roleId === roleId),
        );

        if (!roleMembers.length) return;

        const group = {
            count: roleMembers.length,
            id: groupName,
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

        members = remaining;
    };

    for (const r of hoistedRoles) {
        const groupName = r.role?.name ?? r.roleId ?? "unknown";
        emitRoleGroup(groupName, r.roleId);
    }

    if (members.length) {
        const group = {
            count: members.length,
            id: "online",
        };

        items.push({ group });
        groups.push(group);

        for (const member of members) {
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

async function subscribeToMemberEvents(this: WebSocket, userId: string) {
    if (this.events[userId]) return false; // already subscribed as friend
    if (this.member_events[userId]) return false; // already subscribed in member list
    this.member_events[userId] = await listenEvent(
        userId,
        (opts) => opts?.acknowledge?.(),
        this.listenOptions,
    );
    return true;
}

export async function resyncMemberListWindows(
    this: WebSocket,
    spaceId: string,
) {
    const subs = [...this.memberListSubs.values()].filter(
        (s) => s.spaceId === spaceId,
    );
    if (!subs.length) return;

    const memberCount = await getSpace(spaceId).then(
        (space) => space?.memberCount || 0,
    );

    for (const sub of subs) {
        const ops = await Promise.all(
            sub.ranges.map((r) => getMembers(spaceId, r)),
        );
        const groups = [...new Set(ops.map((x) => x.groups).flat())];

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

export async function onLazyRequest(this: WebSocket, { d }: GatewayPayload) {
    const { spaceId, channels } = d;

    if (!channels) throw new Error("Must provide channel ranges");

    const channel_id = Object.keys(channels || {})[0];
    if (!channel_id) return;

    const ranges = channels[channel_id] as MemberListRange[];
    if (!Array.isArray(ranges)) throw new Error("Not a valid Array");

    const memberCount = await getSpace(spaceId).then(
        (space) => space?.memberCount || 0,
    );

    // Keep your existing list id for now
    const listId = channel_id;

    // Track subscription per socket so we can resync later
    this.memberListSubs.set(`${spaceId}:${listId}`, {
        spaceId,
        listId,
        channelId: channel_id,
        ranges,
    });

    const ops = await Promise.all(ranges.map((x) => getMembers(spaceId, x)));

    for (const op of ops) {
        for (const member of op.members) {
            const userId = member?.user?.id;
            if (!userId) continue;
            void subscribeToMemberEvents.call(this, userId);
        }
    }

    const groups = [...new Set(ops.map((x) => x.groups).flat())];

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
            id: listId,
            spaceId,
            groups,
        },
    });

    logger.info(`LAZY_REQUEST ${spaceId} ${channel_id}`);
}
