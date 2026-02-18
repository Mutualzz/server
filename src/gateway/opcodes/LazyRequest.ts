import { logger } from "../Logger";
import { type MemberListRange, Send } from "../util";
import type { GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { getChannelOverwrites } from "@mutualzz/util";
import {
    computeListIdFromOverwrites,
    computeVisibleUserIds,
    getEveryonePermissions,
    getMemberCount,
    getMembers,
    getParentOverwrites,
    subscribeToMemberEvents,
} from "../util/Calculations";

export async function onLazyRequest(this: WebSocket, { d }: GatewayPayload) {
    const { spaceId, channels } = d;
    if (!channels) throw new Error("Must provide channel ranges");

    const channelId = Object.keys(channels)[0];
    if (!channelId) return;

    const ranges = channels[channelId] as MemberListRange[];
    if (!Array.isArray(ranges)) throw new Error("Not a valid Array");

    const memberCount = await getMemberCount(spaceId);

    const everyonePerms = await getEveryonePermissions(spaceId);
    const channelOverwrites = await getChannelOverwrites(spaceId, channelId);
    const parentOverwrites = await getParentOverwrites(spaceId, channelId);

    const listId = computeListIdFromOverwrites({
        parentOverwrites,
        channelOverwrites,
    });

    const subKey = `${spaceId}:${channelId}:${listId}`;

    this.memberListSubs.set(subKey, {
        spaceId,
        listId,
        channelId,
        ranges,
    });

    const ops = await Promise.all(
        ranges.map((x) =>
            getMembers(
                spaceId,
                x,
                channelOverwrites,
                parentOverwrites,
                everyonePerms,
            ),
        ),
    );

    for (const op of ops) {
        for (const member of op.members) {
            const userId = member?.user?.id ?? member?.userId;
            if (!userId) continue;
            void subscribeToMemberEvents.call(this, String(userId));
        }
    }

    const groupsMap = new Map<string, any>();
    for (const g of ops.flatMap((x) => x.groups)) groupsMap.set(g.id, g);
    const groups = [...groupsMap.values()];

    const visibleUserIds = computeVisibleUserIds(ops);
    this.presences = this.presences ?? new Map();

    this.presences.set(subKey, visibleUserIds);

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

    logger.info(`LAZY_REQUEST ${spaceId} ${channelId} listId=${listId}`);
}
