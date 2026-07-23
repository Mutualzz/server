import { logger } from "../Logger";
import { type MemberListRange, Send, SessionRuntime } from "../util";
import type { GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { getChannelOverwrites, getMember, getSpace } from "@mutualzz/util";
import {
  canViewChannel,
  computeListIdFromOverwrites,
  computeVisibleUserIds,
  getEveryonePermissions,
  getMembers,
  getParentOverwrites,
  subscribeToMemberEvents,
} from "../util/Calculations";

export async function onLazyRequest(this: WebSocket, { d }: GatewayPayload) {
  if (!this.userId) return;

  const { spaceId, channels } = d;
  if (!spaceId || !channels) throw new Error("Must provide channel ranges");

  const channelId = Object.keys(channels)[0];
  if (!channelId) return;

  const ranges = channels[channelId] as MemberListRange[];
  if (!Array.isArray(ranges)) throw new Error("Not a valid Array");

  const space = await getSpace(String(spaceId));
  if (!space) return;

  const isOwner = BigInt(this.userId) === BigInt(space.ownerId);
  const member = await getMember(String(spaceId), this.userId);
  if (!isOwner && !member) return;

  const { allow: everyoneAllow, deny: everyoneDeny } =
    await getEveryonePermissions(spaceId);
  const channelOverwrites = await getChannelOverwrites(spaceId, channelId);
  const parentOverwrites = await getParentOverwrites(spaceId, channelId);

  if (
    !isOwner &&
    (!member ||
      !canViewChannel({
        member,
        spaceId,
        channelOverwrites,
        parentOverwrites,
        everyoneAllow,
        everyoneDeny,
      }))
  ) {
    return;
  }

  const listId = computeListIdFromOverwrites({
    parentOverwrites,
    channelOverwrites,
  });

  const subKey = `${spaceId}:${channelId}:${listId}`;

  this.memberListSubs?.set(subKey, {
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
        everyoneAllow,
        everyoneDeny,
      ),
    ),
  );

  for (const op of ops) {
    for (const memberRow of op.members) {
      const userId = memberRow?.user?.id ?? memberRow?.userId;
      if (!userId) continue;
      void subscribeToMemberEvents.call(this, String(userId));
    }
  }

  const groupsMap = new Map<string, any>();
  for (const g of ops.flatMap((x) => x.groups)) groupsMap.set(g.id, g);
  const groups = [...groupsMap.values()];

  const memberCount = ops.reduce((acc, x) => acc + x.members.length, 0);

  const visibleUserIds = computeVisibleUserIds(ops);
  this.presences = this.presences ?? new Map();

  this.presences.set(subKey, visibleUserIds);

  await Send(this, {
    op: "Dispatch",
    s: SessionRuntime.nextSequence(this.sessionId, this),
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
