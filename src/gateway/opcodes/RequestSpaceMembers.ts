import {
  db,
  spaceMemberRolesTable,
  spaceMembersTable,
  usersTable,
} from "@mutualzz/database";
import type { GatewayPayload, Snowflake } from "@mutualzz/types";
import { getMember, getSpace } from "@mutualzz/util";
import {
  gatewayNoncePayload,
  gatewayRequestSpaceMembersPayload,
  MAX_MEMBER_SEARCH_RESULTS,
  MAX_ROLE_MEMBER_RESULTS,
} from "@mutualzz/validators";
import { and, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type HydratedSpaceMember,
  loadSpaceMembers,
} from "../memberList/loadSpaceMembers.ts";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type ChunkResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const viewerMemberships = alias(spaceMembersTable, "viewer_memberships");

const reply = (socket: WebSocket, nonce: string, result: ChunkResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "SpaceMembersChunk",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...result },
  });

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function nameMatches(query: string) {
  const pattern = `%${escapeLikePattern(query)}%`;
  return or(
    ilike(spaceMembersTable.nickname, pattern),
    ilike(usersTable.globalName, pattern),
    ilike(usersTable.username, pattern),
  );
}

async function findMatchingUserIds(
  spaceId: Snowflake,
  query: string,
  limit: number,
) {
  const rows = await db
    .select({ userId: spaceMembersTable.userId })
    .from(spaceMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, spaceMembersTable.userId))
    .where(
      and(eq(spaceMembersTable.spaceId, BigInt(spaceId)), nameMatches(query)),
    )
    .limit(limit);

  return rows.map((row) => String(row.userId));
}

async function findMutualMembers(
  viewerId: Snowflake,
  query: string,
  limit: number,
) {
  const rows = await db
    .select({
      spaceId: spaceMembersTable.spaceId,
      userId: spaceMembersTable.userId,
    })
    .from(spaceMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, spaceMembersTable.userId))
    .where(
      and(
        inArray(
          spaceMembersTable.spaceId,
          db
            .select({ spaceId: viewerMemberships.spaceId })
            .from(viewerMemberships)
            .where(eq(viewerMemberships.userId, BigInt(viewerId))),
        ),
        ne(spaceMembersTable.userId, BigInt(viewerId)),
        nameMatches(query),
      ),
    )
    .limit(limit);

  const userIdsBySpace = new Map<Snowflake, Snowflake[]>();
  for (const row of rows) {
    const spaceId = String(row.spaceId);
    const userIds = userIdsBySpace.get(spaceId) ?? [];
    userIds.push(String(row.userId));
    userIdsBySpace.set(spaceId, userIds);
  }

  const loaded = await Promise.all(
    [...userIdsBySpace].map(([spaceId, userIds]) =>
      loadSpaceMembers(spaceId, userIds),
    ),
  );

  return loaded.flatMap((members) => [...members.values()]);
}

async function findRoleUserIds(
  spaceId: Snowflake,
  roleId: Snowflake,
  limit: number,
) {
  if (roleId === spaceId) {
    const rows = await db
      .select({ userId: spaceMembersTable.userId })
      .from(spaceMembersTable)
      .where(eq(spaceMembersTable.spaceId, BigInt(spaceId)))
      .limit(limit);
    return rows.map((row) => String(row.userId));
  }

  const rows = await db
    .select({ userId: spaceMemberRolesTable.userId })
    .from(spaceMemberRolesTable)
    .where(
      and(
        eq(spaceMemberRolesTable.spaceId, BigInt(spaceId)),
        eq(spaceMemberRolesTable.roleId, BigInt(roleId)),
      ),
    )
    .limit(limit);
  return rows.map((row) => String(row.userId));
}

export async function onRequestSpaceMembers(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const { userId } = this;
  if (!userId) return;

  const parsed = gatewayRequestSpaceMembersPayload.safeParse(d);
  if (!parsed.success) {
    const nonceOnly = gatewayNoncePayload.safeParse(d);
    if (nonceOnly.success)
      await reply(this, nonceOnly.data.nonce, {
        ok: false,
        message: "Invalid request",
      });
    return;
  }

  const { spaceId, nonce, userIds, query, roleId, limit } = parsed.data;
  const searchLimit = Math.min(
    limit ?? MAX_MEMBER_SEARCH_RESULTS,
    MAX_MEMBER_SEARCH_RESULTS,
  );

  if (!spaceId) {
    const members: HydratedSpaceMember[] = query
      ? await findMutualMembers(userId, query, searchLimit)
      : [];
    return reply(this, nonce, {
      ok: true,
      spaceId: null,
      members,
      notFound: [],
    });
  }

  const [space, requester] = await Promise.all([
    getSpace(spaceId),
    getMember(spaceId, userId),
  ]);
  const isOwner = !!space && String(space.ownerId) === userId;
  if (!space || (!requester && !isOwner))
    return reply(this, nonce, { ok: false, message: "Space not found" });

  let targetUserIds: Snowflake[];
  if (userIds) targetUserIds = [...new Set(userIds)];
  else if (query)
    targetUserIds = await findMatchingUserIds(spaceId, query, searchLimit);
  else
    targetUserIds = await findRoleUserIds(
      spaceId,
      roleId ?? spaceId,
      Math.min(limit ?? MAX_ROLE_MEMBER_RESULTS, MAX_ROLE_MEMBER_RESULTS),
    );

  const members = await loadSpaceMembers(spaceId, targetUserIds);
  const notFound = userIds
    ? targetUserIds.filter((targetUserId) => !members.has(targetUserId))
    : [];

  return reply(this, nonce, {
    ok: true,
    spaceId,
    members: [...members.values()],
    notFound,
  });
}
