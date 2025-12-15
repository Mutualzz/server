import { db, spaceMembersTable } from "@mutualzz/database";
import { logger } from "@mutualzz/gateway/Logger";
import { Send } from "@mutualzz/gateway/util";
import type { APIRole, APISpaceMember, GatewayPayload } from "@mutualzz/types";
import {
    arrayPartition,
    execNormalizedMany,
    getSpace,
    listenEvent,
} from "@mutualzz/util";
import { eq } from "drizzle-orm";
import type { WebSocket } from "../util/WebSocket";

async function getMembers(spaceId: string, range: [number, number]) {
    if (!Array.isArray(range) || range.length !== 2)
        throw new Error("range is not a valid array");

    let members = await execNormalizedMany<APISpaceMember>(
        db.query.spaceMembersTable.findMany({
            where: eq(spaceMembersTable.spaceId, BigInt(spaceId)),
            with: {
                user: true,
                roles: true,
            },
            offset: Number(range[0]) || 0,
            limit: Number(range[1]) || 100,
        }),
    );

    if (!members || !members.length) {
        return {
            items: [],
            groups: [],
            range: [],
            members: [],
        };
    }

    const groups: any[] = [];
    const items: any[] = [];
    const member_roles = [
        ...new Map(
            members
                .map((m) => m.roles)
                .flat()
                .map(
                    (role) => [role?.id, role] as unknown as [string, APIRole],
                ),
        ).values(),
    ];
    member_roles.push(
        member_roles.splice(
            member_roles.findIndex((x) => x.id === x.spaceId),
            1,
        )[0],
    );

    const offlineItems: any[] = [];
    for (const role of member_roles) {
        const [role_members, other_members] = arrayPartition(
            members,
            (m) => !!m.roles?.find((r) => r.id === role.id),
        );

        const group = {
            count: role_members.length,
            id: role.id === spaceId ? "online" : role.id,
        };

        items.push({ group });
        groups.push(group);

        for (const member of role_members) {
            const roles =
                member.roles
                    ?.filter((x) => x.id !== spaceId)
                    .map((x) => x.id) ?? [];

            const item = {
                member: {
                    ...member,
                    roles,
                    user: member.user,
                },
            };

            items.push(item);
        }

        members = other_members;
    }

    if (offlineItems.length) {
        const group = {
            count: offlineItems.length,
            id: "offline",
        };
        items.push({ group });
        groups.push(group);

        items.push(...offlineItems);
    }

    return {
        items,
        groups,
        range,
        members: items
            .map((x) => ("member" in x ? x.member : undefined))
            .filter((x) => !!x),
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

export async function onLazyRequest(this: WebSocket, { d }: GatewayPayload) {
    const { spaceId, channels } = d;

    if (!channels) throw new Error("Must provide channel ranges");

    const channel_id = Object.keys(channels || {})[0];
    if (!channel_id) return;

    const ranges = channels[channel_id];
    if (!Array.isArray(ranges)) throw new Error("Not a valid Array");

    const memberCount = await getSpace(spaceId).then(
        (space) => space?.memberCount || 0,
    );
    const ops = await Promise.all(ranges.map((x) => getMembers(spaceId, x)));

    let listId = "everyone";

    ops.forEach((op) => {
        op.members.forEach(async (member) => {
            if (!member?.user.id) return;
            return subscribeToMemberEvents.call(this, member.user.id);
        });
    });

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
