import type { APISpaceMember, Snowflake } from "@mutualzz/types";
import {
  db,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  usersTable,
} from "@mutualzz/database";
import { and, eq } from "drizzle-orm";
import type { Channel } from "amqplib";
import {
  type EventOpts,
  getChannelOverwrites,
  getSpace,
  listenEvent,
  RabbitMQ,
} from "@mutualzz/util";
import { MEMBER_LIST_CHUNK_SIZE } from "@mutualzz/validators";
import { logger } from "../Logger.ts";
import { PresenceService } from "../presence/Presence.service.ts";
import {
  type HydratedSpaceMember,
  loadSpaceMembers,
} from "./loadSpaceMembers.ts";
import {
  canViewChannel,
  getEveryonePermissions,
  getParentOverwrites,
  offlineLike,
} from "../util/Calculations.ts";
import { Send } from "../util/Send.ts";
import { SessionRuntime } from "../util/SessionRuntime.ts";
import type { WebSocket } from "../util/WebSocket.ts";
import {
  MemberListState,
  OFFLINE_GROUP_ID,
  ONLINE_GROUP_ID,
  type MemberListEntry,
  type MemberListOp,
  type MemberListRow,
} from "./MemberListState.ts";
import {
  chunksToRanges,
  planWindowOps,
  type WindowPlan,
} from "./MemberListWindow.ts";

export const HIDE_OFFLINE_MEMBER_THRESHOLD = 1000;
const DROP_DELAY_MS = 60_000;
const FLUSH_DELAY_MS = 100;
const REBUILD_AFTER_CHANNEL_LOSS_MS = 5_000;

const MEMBER_LIST_EVENTS = new Set<string>([
  "SpaceMemberAdd",
  "SpaceMemberUpdate",
  "SpaceMemberRemove",
  "SpaceMemberRoleAdd",
  "SpaceMemberRoleAddBulk",
  "SpaceMemberRoleRemove",
  "UserUpdate",
  "RoleCreate",
  "RoleUpdate",
  "RoleDelete",
  "SpaceUpdate",
]);

type ChannelOverwrites = Awaited<ReturnType<typeof getChannelOverwrites>>;
type ParentOverwrites = Awaited<ReturnType<typeof getParentOverwrites>>;

interface SpaceRole {
  id: Snowflake;
  name: string;
  position: number;
  hoist: boolean;
  allow: bigint;
  deny: bigint;
}

export interface MemberRecord {
  userId: Snowflake;
  nickname: string | null;
  globalName: string | null;
  username: string;
  roleIds: Snowflake[];
  online: boolean;
}

interface ListSubscriber {
  socket: WebSocket;
  channelId: Snowflake;
  chunks: Set<number>;
  nextChunks: Set<number> | null;
  initialized: boolean;
}

export interface MemberListHandle {
  key: string;
  spaceId: Snowflake;
  listId: string;
  state: MemberListState;
  roles: Map<Snowflake, SpaceRole>;
  members: Map<Snowflake, MemberRecord>;
  channelOverwrites: ChannelOverwrites;
  parentOverwrites: ParentOverwrites;
  everyoneAllow: bigint;
  everyoneDeny: bigint;
  ownerId: Snowflake | null;
  hideOffline: boolean;
  subscribers: Map<string, ListSubscriber>;
  pendingOps: MemberListOp[];
  flushedRowCount: number;
  flushTimer: NodeJS.Timeout | null;
  flushChain: Promise<void>;
  dropTimer: NodeJS.Timeout | null;
}

export type MemberListItem =
  | { group: { id: string; name: string; count: number } }
  | { member: HydratedSpaceMember }
  | null;

type BufferedChange =
  | { kind: "event"; event: EventOpts }
  | { kind: "presence"; userId: Snowflake; online: boolean };

interface BuildBuffer {
  spaceId: Snowflake;
  changes: BufferedChange[];
}

interface PlannedDelivery {
  sessionId: string;
  subscriber: ListSubscriber;
  reset: boolean;
  chunks: number[];
  plan: WindowPlan;
  fills: { index: number; row: MemberListRow }[];
  syncs: { start: number; end: number; rows: MemberListRow[] }[];
}

const lists = new Map<string, MemberListHandle>();
const pendingBuilds = new Map<string, Promise<MemberListHandle>>();
const buildBuffers = new Map<string, BuildBuffer>();
const spaceListeners = new Map<Snowflake, Promise<() => unknown>>();
const spaceEventChains = new Map<Snowflake, Promise<void>>();
let eventChannel: Promise<Channel | undefined> | null = null;

export function memberListKey(spaceId: Snowflake, listId: string) {
  return `${spaceId}:${listId}`;
}

function windowPresenceKey(spaceId: Snowflake) {
  return `memberList:${spaceId}`;
}

function rowKey(row: MemberListRow) {
  return row.type === "group" ? `group:${row.id}` : `member:${row.userId}`;
}

function rowAt(handle: MemberListHandle, index: number) {
  const [row] = handle.state.slice(index, index + 1);
  return row;
}

function forSpace(spaceId: Snowflake) {
  return [...lists.values()].filter((handle) => handle.spaceId === spaceId);
}

function displayName(record: MemberRecord) {
  return record.nickname ?? (record.globalName || record.username);
}

function canSeeList(handle: MemberListHandle, record: MemberRecord) {
  const permissionMember = {
    spaceId: handle.spaceId,
    userId: record.userId,
    roles: record.roleIds.map((roleId) => ({
      spaceId: handle.spaceId,
      userId: record.userId,
      roleId,
      role: handle.roles.get(roleId),
    })),
  } as unknown as APISpaceMember;

  return canViewChannel({
    member: permissionMember,
    spaceId: handle.spaceId,
    channelOverwrites: handle.channelOverwrites,
    parentOverwrites: handle.parentOverwrites,
    everyoneAllow: handle.everyoneAllow,
    everyoneDeny: handle.everyoneDeny,
    ownerId: handle.ownerId,
  });
}

export function toEntry(
  handle: MemberListHandle,
  record: MemberRecord,
): MemberListEntry | null {
  if (!canSeeList(handle, record)) return null;
  return {
    userId: record.userId,
    name: displayName(record),
    roleIds: [...record.roleIds],
    online: record.online,
  };
}

export function rebuildList(handle: MemberListHandle) {
  const entries = [...handle.members.values()].flatMap((record) => {
    const entry = toEntry(handle, record);
    return entry ? [entry] : [];
  });

  handle.hideOffline = handle.members.size > HIDE_OFFLINE_MEMBER_THRESHOLD;
  handle.state.rebuild([...handle.roles.values()], entries, {
    hideOffline: handle.hideOffline,
  });
}

function groupName(handle: MemberListHandle, groupId: string) {
  if (groupId === ONLINE_GROUP_ID) return "Online";
  if (groupId === OFFLINE_GROUP_ID) return "Offline";
  return handle.roles.get(groupId)?.name ?? groupId;
}

export function groupSummaries(handle: MemberListHandle) {
  return handle.state.groups.map((group) => ({
    ...group,
    name: groupName(handle, group.id),
  }));
}

function ensureEventChannel(): Promise<Channel | undefined> {
  const connection = RabbitMQ.connection;
  if (!connection) return Promise.resolve(undefined);

  eventChannel ??= connection
    .createChannel()
    .then((channel) => {
      RabbitMQ.attachChannelHandlers(channel, "memberList");
      channel.on("close", () => {
        eventChannel = null;
        handleEventChannelLost();
      });
      return channel;
    })
    .catch((error: unknown) => {
      eventChannel = null;
      throw error;
    });

  return eventChannel;
}

function ensureSpaceListener(spaceId: Snowflake) {
  const existing = spaceListeners.get(spaceId);
  if (existing) return existing;

  const listener = ensureEventChannel().then((channel) =>
    listenEvent(spaceId, (event) => onSpaceEvent(spaceId, event), {
      channel,
      acknowledge: false,
    }),
  );
  spaceListeners.set(spaceId, listener);
  listener.catch(() => {
    if (spaceListeners.get(spaceId) === listener)
      spaceListeners.delete(spaceId);
  });

  return listener;
}

function releaseSpaceListener(spaceId: Snowflake) {
  if (forSpace(spaceId).length > 0) return;
  if ([...pendingBuilds.keys()].some((key) => key.startsWith(`${spaceId}:`)))
    return;

  const listener = spaceListeners.get(spaceId);
  if (!listener) return;

  spaceListeners.delete(spaceId);
  spaceEventChains.delete(spaceId);
  void listener.then((cancel) => cancel()).catch(() => undefined);
}

function handleEventChannelLost() {
  logger.warn("[MemberList] event channel closed, rebuilding lists");

  const staleHandles = [...lists.values()];
  lists.clear();
  spaceListeners.clear();
  spaceEventChains.clear();

  for (const handle of staleHandles) {
    cancelDrop(handle);
    if (handle.flushTimer) clearTimeout(handle.flushTimer);
    handle.flushTimer = null;
  }

  setTimeout(() => {
    for (const handle of staleHandles) void rebuildStaleList(handle);
  }, REBUILD_AFTER_CHANNEL_LOSS_MS).unref?.();
}

async function rebuildStaleList(staleHandle: MemberListHandle) {
  const subscribers = [...staleHandle.subscribers.entries()].filter(
    ([, subscriber]) =>
      subscriber.socket.memberListWindows?.get(staleHandle.spaceId)?.key ===
      staleHandle.key,
  );
  const [firstSubscriber] = subscribers;
  if (!firstSubscriber) return;

  try {
    const handle = await acquire(
      staleHandle.spaceId,
      staleHandle.listId,
      firstSubscriber[1].channelId,
    );

    for (const [sessionId, subscriber] of subscribers) {
      if (handle.subscribers.has(sessionId)) continue;
      handle.subscribers.set(sessionId, {
        socket: subscriber.socket,
        channelId: subscriber.channelId,
        chunks: new Set(),
        nextChunks: subscriber.nextChunks ?? subscriber.chunks,
        initialized: false,
      });
    }

    cancelDrop(handle);
    scheduleFlush(handle, 0);
  } catch (error) {
    logger.error(`[MemberList] rebuild failed for ${staleHandle.key}:`, error);
  }
}

function onSpaceEvent(spaceId: Snowflake, event: EventOpts) {
  if (!MEMBER_LIST_EVENTS.has(event.event)) return;

  for (const buffer of buildBuffers.values())
    if (buffer.spaceId === spaceId)
      buffer.changes.push({ kind: "event", event });

  const previous = spaceEventChains.get(spaceId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      for (const handle of forSpace(spaceId))
        await applyEventToHandle(handle, event);
    })
    .catch((error: unknown) => {
      logger.error(`[MemberList] failed to apply ${event.event}:`, error);
    });
  spaceEventChains.set(spaceId, next);
}

async function loadMemberRecord(
  spaceId: Snowflake,
  userId: Snowflake,
): Promise<MemberRecord | null> {
  const spaceKey = BigInt(spaceId);
  const userKey = BigInt(userId);

  const [memberRows, memberRoleRows, presence] = await Promise.all([
    db
      .select({
        nickname: spaceMembersTable.nickname,
        globalName: usersTable.globalName,
        username: usersTable.username,
      })
      .from(spaceMembersTable)
      .innerJoin(usersTable, eq(usersTable.id, spaceMembersTable.userId))
      .where(
        and(
          eq(spaceMembersTable.spaceId, spaceKey),
          eq(spaceMembersTable.userId, userKey),
        ),
      )
      .limit(1),
    db
      .select({ roleId: spaceMemberRolesTable.roleId })
      .from(spaceMemberRolesTable)
      .where(
        and(
          eq(spaceMemberRolesTable.spaceId, spaceKey),
          eq(spaceMemberRolesTable.userId, userKey),
        ),
      ),
    PresenceService.getPublic(userId),
  ]);

  const [memberRow] = memberRows;
  if (!memberRow) return null;

  return {
    userId,
    nickname: memberRow.nickname,
    globalName: memberRow.globalName,
    username: memberRow.username,
    roleIds: memberRoleRows
      .map((memberRoleRow) => String(memberRoleRow.roleId))
      .filter((roleId) => roleId !== spaceId),
    online: !offlineLike(presence),
  };
}

function queueOps(handle: MemberListHandle, ops: MemberListOp[]) {
  if (!ops.length) return;
  handle.pendingOps.push(...ops);
  scheduleFlush(handle, FLUSH_DELAY_MS);
}

function refreshMember(handle: MemberListHandle, record: MemberRecord) {
  const entry = toEntry(handle, record);
  queueOps(
    handle,
    entry
      ? handle.state.upsertMember(entry)
      : handle.state.removeMember(record.userId),
  );
}

function invalidate(handle: MemberListHandle) {
  rebuildList(handle);
  handle.pendingOps = [];
  handle.flushedRowCount = handle.state.rowCount;

  for (const subscriber of handle.subscribers.values()) {
    if (subscriber.initialized)
      subscriber.nextChunks = subscriber.nextChunks ?? subscriber.chunks;
    subscriber.chunks = new Set();
    subscriber.initialized = false;
  }

  scheduleFlush(handle, 0);
}

function checkHideOfflineThreshold(handle: MemberListHandle) {
  const hideOffline = handle.members.size > HIDE_OFFLINE_MEMBER_THRESHOLD;
  if (hideOffline !== handle.hideOffline) invalidate(handle);
}

function changeMemberRoles(
  handle: MemberListHandle,
  userIds: Snowflake[],
  change: (roleIds: Snowflake[]) => Snowflake[],
) {
  for (const userId of userIds) {
    const record = handle.members.get(userId);
    if (!record) continue;
    record.roleIds = change(record.roleIds);
    refreshMember(handle, record);
  }
}

function toSpaceRole(data: Record<string, unknown>): SpaceRole {
  return {
    id: String(data.id),
    name: String(data.name ?? ""),
    position: Number(data.position ?? 0),
    hoist: Boolean(data.hoist),
    allow: BigInt(String(data.allow ?? 0)),
    deny: BigInt(String(data.deny ?? 0)),
  };
}

async function applyEventToHandle(
  handle: MemberListHandle,
  { event, data }: EventOpts,
) {
  switch (event) {
    case "SpaceMemberAdd":
    case "SpaceMemberUpdate": {
      const userId = String(data?.userId ?? data?.user?.id);
      const record = await loadMemberRecord(handle.spaceId, userId);
      if (!record) return;
      handle.members.set(userId, record);
      refreshMember(handle, record);
      checkHideOfflineThreshold(handle);
      return;
    }
    case "SpaceMemberRemove": {
      const userId = String(data?.userId);
      if (!handle.members.delete(userId)) return;
      queueOps(handle, handle.state.removeMember(userId));
      checkHideOfflineThreshold(handle);
      return;
    }
    case "UserUpdate": {
      const record = handle.members.get(String(data?.id));
      if (!record) return;
      record.globalName = data?.globalName ?? null;
      record.username = data?.username ?? record.username;
      refreshMember(handle, record);
      return;
    }
    case "SpaceMemberRoleAdd": {
      const roleId = String(data?.roleId);
      changeMemberRoles(handle, [String(data?.userId)], (roleIds) =>
        roleIds.includes(roleId) ? roleIds : [...roleIds, roleId],
      );
      return;
    }
    case "SpaceMemberRoleAddBulk": {
      const roleId = String(data?.roleId);
      const userIds = ((data?.userIds ?? []) as unknown[]).map(String);
      changeMemberRoles(handle, userIds, (roleIds) =>
        roleIds.includes(roleId) ? roleIds : [...roleIds, roleId],
      );
      return;
    }
    case "SpaceMemberRoleRemove": {
      const roleId = String(data?.roleId);
      changeMemberRoles(handle, [String(data?.userId)], (roleIds) =>
        roleIds.filter((memberRoleId) => memberRoleId !== roleId),
      );
      return;
    }
    case "RoleCreate":
    case "RoleUpdate": {
      const role = toSpaceRole(data ?? {});
      if (role.id === handle.spaceId) {
        handle.everyoneAllow = role.allow;
        handle.everyoneDeny = role.deny;
      } else {
        handle.roles.set(role.id, role);
      }
      invalidate(handle);
      return;
    }
    case "SpaceUpdate": {
      const ownerId = data?.ownerId == null ? null : String(data.ownerId);
      if (ownerId === null || ownerId === handle.ownerId) return;
      handle.ownerId = ownerId;
      invalidate(handle);
      return;
    }
    case "RoleDelete": {
      const roleId = String(data?.id);
      handle.roles.delete(roleId);
      for (const record of handle.members.values())
        if (record.roleIds.includes(roleId))
          record.roleIds = record.roleIds.filter(
            (memberRoleId) => memberRoleId !== roleId,
          );
      invalidate(handle);
      return;
    }
  }
}

function applyPresenceToHandle(
  handle: MemberListHandle,
  userId: Snowflake,
  online: boolean,
) {
  const record = handle.members.get(userId);
  if (!record || record.online === online) return;
  record.online = online;
  refreshMember(handle, record);
}

function applyPresence(userId: Snowflake, online: boolean) {
  for (const buffer of buildBuffers.values())
    buffer.changes.push({ kind: "presence", userId, online });
  for (const handle of lists.values())
    applyPresenceToHandle(handle, userId, online);
}

async function buildList(
  spaceId: Snowflake,
  listId: string,
  channelId: Snowflake,
): Promise<MemberListHandle> {
  const key = memberListKey(spaceId, listId);
  const buffer: BuildBuffer = { spaceId, changes: [] };
  buildBuffers.set(key, buffer);

  try {
    await ensureSpaceListener(spaceId);

    const spaceKey = BigInt(spaceId);

    const [
      roleRows,
      memberRows,
      memberRoleRows,
      everyonePermissions,
      channelOverwrites,
      parentOverwrites,
      space,
    ] = await Promise.all([
      db
        .select({
          id: rolesTable.id,
          name: rolesTable.name,
          position: rolesTable.position,
          hoist: rolesTable.hoist,
          allow: rolesTable.allow,
          deny: rolesTable.deny,
        })
        .from(rolesTable)
        .where(eq(rolesTable.spaceId, spaceKey)),
      db
        .select({
          userId: spaceMembersTable.userId,
          nickname: spaceMembersTable.nickname,
          globalName: usersTable.globalName,
          username: usersTable.username,
        })
        .from(spaceMembersTable)
        .innerJoin(usersTable, eq(usersTable.id, spaceMembersTable.userId))
        .where(eq(spaceMembersTable.spaceId, spaceKey)),
      db
        .select({
          userId: spaceMemberRolesTable.userId,
          roleId: spaceMemberRolesTable.roleId,
        })
        .from(spaceMemberRolesTable)
        .where(eq(spaceMemberRolesTable.spaceId, spaceKey)),
      getEveryonePermissions(spaceId),
      getChannelOverwrites(spaceId, channelId),
      getParentOverwrites(spaceId, channelId),
      getSpace(spaceId),
    ]);

    const roles = new Map<Snowflake, SpaceRole>();
    for (const roleRow of roleRows) {
      const roleId = String(roleRow.id);
      if (roleId === spaceId) continue;
      roles.set(roleId, { ...roleRow, id: roleId });
    }

    const roleIdsByUser = new Map<Snowflake, Snowflake[]>();
    for (const memberRoleRow of memberRoleRows) {
      const roleId = String(memberRoleRow.roleId);
      if (roleId === spaceId) continue;
      const userId = String(memberRoleRow.userId);
      const roleIds = roleIdsByUser.get(userId) ?? [];
      roleIds.push(roleId);
      roleIdsByUser.set(userId, roleIds);
    }

    const presences = await PresenceService.getManyPublic(
      memberRows.map((memberRow) => String(memberRow.userId)),
    );

    const members = new Map<Snowflake, MemberRecord>();
    for (const memberRow of memberRows) {
      const userId = String(memberRow.userId);
      members.set(userId, {
        userId,
        nickname: memberRow.nickname,
        globalName: memberRow.globalName,
        username: memberRow.username,
        roleIds: roleIdsByUser.get(userId) ?? [],
        online: !offlineLike(presences.get(userId) ?? null),
      });
    }

    const handle: MemberListHandle = {
      key,
      spaceId,
      listId,
      state: new MemberListState([], [], { hideOffline: false }),
      roles,
      members,
      channelOverwrites,
      parentOverwrites,
      everyoneAllow: everyonePermissions.allow,
      everyoneDeny: everyonePermissions.deny,
      ownerId: space?.ownerId ? String(space.ownerId) : null,
      hideOffline: false,
      subscribers: new Map(),
      pendingOps: [],
      flushedRowCount: 0,
      flushTimer: null,
      flushChain: Promise.resolve(),
      dropTimer: null,
    };

    rebuildList(handle);

    while (buffer.changes.length) {
      const change = buffer.changes.shift();
      if (change?.kind === "event")
        await applyEventToHandle(handle, change.event);
      else if (change)
        applyPresenceToHandle(handle, change.userId, change.online);
    }

    if (handle.flushTimer) clearTimeout(handle.flushTimer);
    handle.flushTimer = null;
    handle.pendingOps = [];
    handle.flushedRowCount = handle.state.rowCount;

    return handle;
  } finally {
    buildBuffers.delete(key);
  }
}

function cancelDrop(handle: MemberListHandle) {
  if (!handle.dropTimer) return;
  clearTimeout(handle.dropTimer);
  handle.dropTimer = null;
}

function scheduleDrop(handle: MemberListHandle) {
  cancelDrop(handle);
  handle.dropTimer = setTimeout(() => {
    handle.dropTimer = null;
    if (handle.subscribers.size > 0) return;
    if (lists.get(handle.key) !== handle) return;

    lists.delete(handle.key);
    if (handle.flushTimer) clearTimeout(handle.flushTimer);
    handle.flushTimer = null;
    releaseSpaceListener(handle.spaceId);
  }, DROP_DELAY_MS);
  handle.dropTimer.unref?.();
}

async function acquire(
  spaceId: Snowflake,
  listId: string,
  channelId: Snowflake,
) {
  const key = memberListKey(spaceId, listId);

  const existing = lists.get(key);
  if (existing) {
    cancelDrop(existing);
    return existing;
  }

  const pending = pendingBuilds.get(key);
  if (pending) return pending;

  const build = buildList(spaceId, listId, channelId)
    .then((handle) => {
      lists.set(key, handle);
      scheduleDrop(handle);
      return handle;
    })
    .finally(() => {
      pendingBuilds.delete(key);
      if (!lists.has(key)) releaseSpaceListener(spaceId);
    });

  pendingBuilds.set(key, build);
  return build;
}

function requestWindow(
  handle: MemberListHandle,
  socket: WebSocket,
  channelId: Snowflake,
  chunks: Set<number>,
) {
  if (!socket.sessionId) return;

  const existing = handle.subscribers.get(socket.sessionId);
  if (existing) {
    existing.socket = socket;
    existing.channelId = channelId;
    existing.nextChunks = chunks;
  } else {
    handle.subscribers.set(socket.sessionId, {
      socket,
      channelId,
      chunks: new Set(),
      nextChunks: chunks,
      initialized: false,
    });
  }

  cancelDrop(handle);
  scheduleFlush(handle, 0);
}

function setWindowPresences(
  socket: WebSocket,
  spaceId: Snowflake,
  handle: MemberListHandle,
  chunks: Iterable<number>,
) {
  const userIds = new Set<string>();
  for (const chunk of chunks) {
    const start = chunk * MEMBER_LIST_CHUNK_SIZE;
    for (const row of handle.state.slice(start, start + MEMBER_LIST_CHUNK_SIZE))
      if (row.type === "member") userIds.add(row.userId);
  }

  socket.presences ??= new Map();
  socket.presences.set(windowPresenceKey(spaceId), userIds);
}

function unsubscribeSpace(socket: WebSocket, spaceId: Snowflake) {
  const window = socket.memberListWindows?.get(spaceId);
  if (!window) return;

  socket.memberListWindows?.delete(spaceId);
  socket.presences?.delete(windowPresenceKey(spaceId));

  const handle = lists.get(window.key);
  if (!handle || !socket.sessionId) return;

  handle.subscribers.delete(socket.sessionId);
  if (handle.subscribers.size === 0) scheduleDrop(handle);
}

function revokeSpace(socket: WebSocket, spaceId: Snowflake) {
  const window = socket.memberListWindows?.get(spaceId);
  if (!window) return;

  const listId = lists.get(window.key)?.listId ?? "";
  unsubscribeSpace(socket, spaceId);

  Send(socket, {
    op: "Dispatch",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    t: "SpaceMemberListUpdate",
    d: {
      spaceId,
      listId,
      channelId: window.channelId,
      memberCount: 0,
      groups: [],
      chunks: [],
      reset: true,
      ops: [],
    },
  }).catch((error: unknown) => {
    logger.debug("[MemberList] revoke send failed:", error);
  });
}

function unsubscribeSocket(socket: WebSocket) {
  for (const spaceId of [...(socket.memberListWindows?.keys() ?? [])])
    unsubscribeSpace(socket, spaceId);
}

function windowChunks(socket: WebSocket, spaceId: Snowflake) {
  const window = socket.memberListWindows?.get(spaceId);
  if (!window || !socket.sessionId) return null;

  const subscriber = lists.get(window.key)?.subscribers.get(socket.sessionId);
  if (!subscriber) return null;

  return subscriber.nextChunks ?? subscriber.chunks;
}

function scheduleFlush(handle: MemberListHandle, delay: number) {
  if (handle.flushTimer) {
    if (delay > 0) return;
    clearTimeout(handle.flushTimer);
  }

  handle.flushTimer = setTimeout(() => {
    handle.flushTimer = null;
    handle.flushChain = handle.flushChain
      .then(() => flush(handle))
      .catch((error: unknown) => {
        logger.error(`[MemberList] flush failed for ${handle.key}:`, error);
      });
  }, delay);
  handle.flushTimer.unref?.();
}

async function flush(handle: MemberListHandle) {
  const ops = handle.pendingOps;
  handle.pendingOps = [];
  const rowCountBefore = handle.flushedRowCount;
  const rowCountAfter = handle.state.rowCount;
  handle.flushedRowCount = rowCountAfter;
  const groups = groupSummaries(handle);

  const rowsToHydrate = new Map<string, MemberListRow>();
  const deliveries: PlannedDelivery[] = [];

  for (const [sessionId, subscriber] of handle.subscribers) {
    const reset = !subscriber.initialized;
    if (!reset && !ops.length && !subscriber.nextChunks) continue;

    const nextChunks = subscriber.nextChunks ?? subscriber.chunks;
    const keptChunks = reset
      ? []
      : [...nextChunks].filter((chunk) => subscriber.chunks.has(chunk));
    const syncChunks = reset
      ? [...nextChunks]
      : [...nextChunks].filter((chunk) => !subscriber.chunks.has(chunk));

    const plan: WindowPlan = reset
      ? { ops: [], fillIndexes: [] }
      : planWindowOps(ops, {
          windowRanges: chunksToRanges(
            subscriber.chunks,
            MEMBER_LIST_CHUNK_SIZE,
          ),
          keepRanges: chunksToRanges(keptChunks, MEMBER_LIST_CHUNK_SIZE),
          rowCountBefore,
          rowCountAfter,
        });

    const fills = plan.fillIndexes.map((index) => ({
      index,
      row: rowAt(handle, index),
    }));

    const syncs = chunksToRanges(syncChunks, MEMBER_LIST_CHUNK_SIZE)
      .map((range) => ({
        start: range.start,
        end: Math.min(range.end, rowCountAfter),
      }))
      .filter((range) => range.start < range.end)
      .map((range) => ({
        ...range,
        rows: handle.state.slice(range.start, range.end),
      }));

    for (const operation of plan.ops)
      if (operation.op !== "DELETE" && operation.row)
        rowsToHydrate.set(rowKey(operation.row), operation.row);
    for (const fill of fills) rowsToHydrate.set(rowKey(fill.row), fill.row);
    for (const sync of syncs)
      for (const row of sync.rows) rowsToHydrate.set(rowKey(row), row);

    subscriber.chunks = new Set(nextChunks);
    subscriber.nextChunks = null;
    subscriber.initialized = true;
    setWindowPresences(
      subscriber.socket,
      handle.spaceId,
      handle,
      subscriber.chunks,
    );

    deliveries.push({
      sessionId,
      subscriber,
      reset,
      chunks: [...subscriber.chunks].sort((left, right) => left - right),
      plan,
      fills,
      syncs,
    });
  }

  if (!deliveries.length) return;

  const uniqueRows = [...rowsToHydrate.values()];
  const items = await hydrate(handle, uniqueRows);
  const itemsByRow = new Map(
    uniqueRows.map((row, index) => [rowKey(row), items[index] ?? null]),
  );
  const itemFor = (row: MemberListRow) => itemsByRow.get(rowKey(row)) ?? null;

  await Promise.allSettled(
    deliveries.map(async (delivery) => {
      if (handle.subscribers.get(delivery.sessionId) !== delivery.subscriber)
        return;

      const { socket } = delivery.subscriber;

      await Send(socket, {
        op: "Dispatch",
        s: SessionRuntime.nextSequence(socket.sessionId, socket),
        t: "SpaceMemberListUpdate",
        d: {
          spaceId: handle.spaceId,
          listId: handle.listId,
          channelId: delivery.subscriber.channelId,
          memberCount: rowCountAfter,
          groups,
          chunks: delivery.chunks,
          reset: delivery.reset,
          ops: [
            ...delivery.plan.ops.map((operation) =>
              operation.op === "DELETE"
                ? operation
                : {
                    op: operation.op,
                    index: operation.index,
                    item: operation.row ? itemFor(operation.row) : undefined,
                  },
            ),
            ...delivery.fills.map((fill) => ({
              op: "UPDATE" as const,
              index: fill.index,
              item: itemFor(fill.row),
            })),
            ...delivery.syncs.map((sync) => ({
              op: "SYNC" as const,
              range: [sync.start, sync.end - 1],
              items: sync.rows.map(itemFor),
            })),
          ],
        },
      });
    }),
  );
}

async function hydrate(
  handle: MemberListHandle,
  rows: MemberListRow[],
): Promise<MemberListItem[]> {
  const userIds = rows.flatMap((row) =>
    row.type === "member" ? [row.userId] : [],
  );

  const membersById = await loadSpaceMembers(handle.spaceId, userIds);
  const groupsById = new Map(
    groupSummaries(handle).map((group) => [group.id, group]),
  );

  return rows.map((row): MemberListItem => {
    if (row.type === "group") {
      const group = groupsById.get(row.id);
      return {
        group: group ?? {
          id: row.id,
          name: groupName(handle, row.id),
          count: 0,
        },
      };
    }

    const member = membersById.get(row.userId);
    if (!member) return null;

    return { member };
  });
}

export const MemberListRegistry = {
  get: (key: string) => lists.get(key),
  forSpace,
  acquire,
  requestWindow,
  unsubscribeSpace,
  unsubscribeSocket,
  windowChunks,
  revokeSpace,
  applyPresence,
};
