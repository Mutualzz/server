import { logger } from "../Logger";
import type { APIChannel, GatewayPayload, Snowflake } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { getChannel, getChannelOverwrites, getSpace } from "@mutualzz/util";
import { gatewayLazyRequestPayload } from "@mutualzz/validators";
import {
  canViewChannel,
  computeListIdFromOverwrites,
  getEveryonePermissions,
  getParentOverwrites,
} from "../util/Calculations";
import { getMemberWithRoles } from "../util/VoicePermissions";
import {
  memberListKey,
  MemberListRegistry,
} from "../memberList/MemberListRegistry";

const CACHE_SETTLE_MS = 1_000;

type ChannelChange = Pick<APIChannel, "id"> &
  Partial<Pick<APIChannel, "parentId" | "overwrites">>;

function overwritesSignature(overwrites: APIChannel["overwrites"]) {
  return computeListIdFromOverwrites({ channelOverwrites: overwrites ?? [] });
}

export async function onLazyRequest(this: WebSocket, { d }: GatewayPayload) {
  if (!this.userId || !this.sessionId) return;

  const parsed = gatewayLazyRequestPayload.safeParse(d);
  if (!parsed.success) {
    logger.warn(`Invalid LazyRequest payload (session: ${this.sessionId})`);
    return;
  }

  const { spaceId, channelId, chunks } = parsed.data;
  await subscribeMemberList(this, spaceId, channelId, new Set(chunks));
}

export async function subscribeMemberList(
  socket: WebSocket,
  spaceId: Snowflake,
  channelId: Snowflake,
  chunks: Set<number>,
) {
  if (!socket.userId) return;

  if (chunks.size === 0) {
    MemberListRegistry.unsubscribeSpace(socket, spaceId);
    return;
  }

  const [space, member, channel] = await Promise.all([
    getSpace(spaceId),
    getMemberWithRoles(spaceId, socket.userId),
    getChannel(channelId),
  ]);

  const isOwner = !!space && BigInt(socket.userId) === BigInt(space.ownerId);
  const belongsToSpace = !!channel && String(channel.spaceId) === spaceId;

  if (!space || !belongsToSpace || (!isOwner && !member)) {
    MemberListRegistry.revokeSpace(socket, spaceId);
    return;
  }

  const [everyonePermissions, channelOverwrites, parentOverwrites] =
    await Promise.all([
      getEveryonePermissions(spaceId),
      getChannelOverwrites(spaceId, channelId),
      getParentOverwrites(spaceId, channelId),
    ]);

  if (
    !isOwner &&
    (!member ||
      !canViewChannel({
        member,
        spaceId,
        channelOverwrites,
        parentOverwrites,
        everyoneAllow: everyonePermissions.allow,
        everyoneDeny: everyonePermissions.deny,
        ownerId: space.ownerId,
      }))
  ) {
    MemberListRegistry.revokeSpace(socket, spaceId);
    return;
  }

  const parentId = channel.parentId ? String(channel.parentId) : null;
  const parent = parentId ? await getChannel(parentId) : null;

  const listId = computeListIdFromOverwrites({
    parentOverwrites,
    channelOverwrites,
  });
  const key = memberListKey(spaceId, listId);

  socket.memberListWindows ??= new Map();
  const previous = socket.memberListWindows.get(spaceId);
  if (previous && previous.key !== key)
    MemberListRegistry.unsubscribeSpace(socket, spaceId);

  socket.memberListWindows.set(spaceId, {
    key,
    channelId,
    parentId,
    channelSignature: overwritesSignature(channel.overwrites),
    parentSignature: parent ? overwritesSignature(parent.overwrites) : null,
  });

  try {
    const handle = await MemberListRegistry.acquire(spaceId, listId, channelId);
    if (socket.memberListWindows?.get(spaceId)?.key !== key) return;
    MemberListRegistry.requestWindow(handle, socket, channelId, chunks);
  } catch (error) {
    if (socket.memberListWindows?.get(spaceId)?.key === key)
      socket.memberListWindows.delete(spaceId);
    logger.error(`[MemberList] subscribe failed for ${key}:`, error);
  }
}

export function recheckMemberList(socket: WebSocket, spaceId: Snowflake) {
  const window = socket.memberListWindows?.get(spaceId);
  if (!window) return;

  const chunks = MemberListRegistry.windowChunks(socket, spaceId);
  if (!chunks) return;

  setTimeout(() => {
    if (socket.memberListWindows?.get(spaceId) !== window) return;
    subscribeMemberList(
      socket,
      spaceId,
      window.channelId,
      new Set(chunks),
    ).catch((error: unknown) => {
      logger.error("[MemberList] recheck failed:", error);
    });
  }, CACHE_SETTLE_MS).unref?.();
}

export function refreshMemberListWindows(
  socket: WebSocket,
  channel: ChannelChange,
) {
  const updatedId = String(channel.id);
  const signature = Array.isArray(channel.overwrites)
    ? overwritesSignature(channel.overwrites)
    : null;
  const updatedParentId =
    channel.parentId === undefined
      ? undefined
      : channel.parentId
        ? String(channel.parentId)
        : null;

  for (const [spaceId, window] of [...(socket.memberListWindows ?? [])]) {
    const isWatched = window.channelId === updatedId;
    const isParent = window.parentId === updatedId;

    const changed =
      (isWatched &&
        updatedParentId !== undefined &&
        updatedParentId !== window.parentId) ||
      (isWatched &&
        signature !== null &&
        signature !== window.channelSignature) ||
      (isParent && signature !== null && signature !== window.parentSignature);

    if (changed) recheckMemberList(socket, spaceId);
  }
}

export function unsubscribeMemberListsFor(
  socket: WebSocket,
  removedId: Snowflake,
) {
  for (const [spaceId, window] of [...(socket.memberListWindows ?? [])])
    if (spaceId === removedId || window.channelId === removedId)
      MemberListRegistry.unsubscribeSpace(socket, spaceId);
}
