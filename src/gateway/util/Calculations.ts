import {
  channelMemberOverwritesTable,
  channelRoleOverwritesTable,
  channelsTable,
  db,
  rolesTable,
} from "@mutualzz/database";
import { and, eq } from "drizzle-orm";
import {
  hasAll,
  hasAny,
  permissionFlags,
  resolveEffectiveChannelBits,
} from "@mutualzz/bitfield";
import { murmur } from "@mutualzz/util";
import type {
  APISpaceMember,
  APIUser,
  PresencePayload,
  Snowflake,
} from "@mutualzz/types";
import { PresenceService } from "../presence/Presence.service.ts";

interface OverwriteLike {
  roleId?: string | null;
  userId?: string | null;
  allow: bigint;
  deny: bigint;
}

export async function getEveryonePermissions(spaceId: Snowflake) {
  const row = await db
    .select({
      allow: rolesTable.allow,
      deny: rolesTable.deny,
    })
    .from(rolesTable)
    .where(eq(rolesTable.id, BigInt(spaceId)))
    .limit(1)
    .then((res) => res[0]);

  if (row == null) return { allow: 0n, deny: 0n };
  return {
    allow: row.allow ?? 0n,
    deny: row.deny ?? 0n,
  };
}

export async function getChannelOverwrites(
  spaceId: Snowflake,
  channelId: Snowflake,
): Promise<OverwriteLike[]> {
  const [roleRows, memberRows] = await Promise.all([
    db
      .select({
        roleId: channelRoleOverwritesTable.roleId,
        allow: channelRoleOverwritesTable.allow,
        deny: channelRoleOverwritesTable.deny,
      })
      .from(channelRoleOverwritesTable)
      .where(
        and(
          eq(channelRoleOverwritesTable.spaceId, BigInt(spaceId)),
          eq(channelRoleOverwritesTable.channelId, BigInt(channelId)),
        ),
      ),
    db
      .select({
        userId: channelMemberOverwritesTable.userId,
        allow: channelMemberOverwritesTable.allow,
        deny: channelMemberOverwritesTable.deny,
      })
      .from(channelMemberOverwritesTable)
      .where(
        and(
          eq(channelMemberOverwritesTable.spaceId, BigInt(spaceId)),
          eq(channelMemberOverwritesTable.channelId, BigInt(channelId)),
        ),
      ),
  ]);

  return [
    ...roleRows.map((r) => ({
      roleId: r.roleId.toString(),
      userId: null,
      allow: r.allow ?? 0n,
      deny: r.deny ?? 0n,
    })),
    ...memberRows.map((r) => ({
      roleId: null,
      userId: r.userId.toString(),
      allow: r.allow ?? 0n,
      deny: r.deny ?? 0n,
    })),
  ];
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
    .then((res) => res[0])
    .catch(() => null);

  if (!parent) return null;

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
      const { roleId, userId } = ow;
      const allow = BigInt(ow.allow);
      const deny = BigInt(ow.deny);

      const key =
        roleId != null ? `r:${roleId}` : userId != null ? `u:${userId}` : "x";

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
  everyoneAllow: bigint,
  everyoneDeny: bigint,
  spaceId: Snowflake,
): bigint {
  // Start with @everyone allow
  let bits = 0n;
  bits |= everyoneAllow;

  // Add all role allows
  const roles = member.roles ?? [];
  for (const mr of roles) {
    const { roleId } = mr;
    if (!roleId || roleId === spaceId) continue;
    bits |= BigInt(mr.role?.allow ?? 0n);
  }

  // Apply @everyone deny
  bits &= ~everyoneDeny;

  // Apply role denies
  for (const mr of roles) {
    const { roleId } = mr;
    if (!roleId || roleId === spaceId) continue;
    bits &= ~BigInt(mr.role?.deny ?? 0n);
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
  everyoneAllow: bigint;
  everyoneDeny: bigint;
  ownerId?: Snowflake | null;
}): boolean {
  const {
    member,
    spaceId,
    channelOverwrites,
    parentOverwrites,
    everyoneAllow,
    everyoneDeny,
    ownerId,
  } = opts;

  if (ownerId != null && String(member.userId) === String(ownerId)) return true;

  const memberRoleIds = computeMemberRoleIds(member, spaceId);
  const baseBits = computeMemberBaseBits(
    member,
    everyoneAllow,
    everyoneDeny,
    spaceId,
  );

  if (hasAll(baseBits, permissionFlags.Administrator)) return true;

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

export function unavailableLike(presence: PresencePayload | null): boolean {
  const status = presence?.status ?? "offline";
  return status === "offline" || status === "invisible" || status === "dnd";
}

export async function attachPresenceUser(user: APIUser): Promise<APIUser> {
  const presence = await PresenceService.getPublic(user.id);

  return {
    ...user,
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
