import {
  bridgeMembersTable,
  bridgesTable,
  db,
} from "@mutualzz/database";
import { emitEvent, fireAndForget } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import { AppBridgePeer } from "./AppBridgePeer";

export type BridgeRole = "owner" | "member";

export const userCanAccessBridge = (
  userId: string | bigint,
  bridge: { ownerId: bigint },
  isMember: boolean,
) => {
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  return bridge.ownerId === uid || isMember;
};

export const bridgeRoleForUser = (
  userId: string | bigint,
  bridge: { ownerId: bigint },
  isMember: boolean,
): BridgeRole | null => {
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  if (bridge.ownerId === uid) return "owner";
  if (isMember) return "member";
  return null;
};

/** Insert membership if missing. Returns true when a new row was created. */
export const ensureMember = async (
  bridgeId: string | bigint,
  userId: string | bigint,
): Promise<boolean> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);

  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, bid),
  });
  if (!bridge) return false;
  // Owner is always treated as a member; no row needed.
  if (bridge.ownerId === uid) return false;

  const existing = await db.query.bridgeMembersTable.findFirst({
    where: and(
      eq(bridgeMembersTable.bridgeId, bid),
      eq(bridgeMembersTable.userId, uid),
    ),
  });
  if (existing) return false;

  await db.insert(bridgeMembersTable).values({
    bridgeId: bid,
    userId: uid,
  });

  AppBridgePeer.addRecipient(bid.toString(), uid.toString());

  fireAndForget(() =>
    emitEvent({
      event: "BridgeMemberAdd",
      user_id: uid.toString(),
      data: {
        bridgeId: bid.toString(),
        name: bridge.name,
        role: "member" as const,
      },
    }),
  );

  return true;
};

/** Remove membership. Owners cannot be removed this way. */
export const removeMember = async (
  bridgeId: string | bigint,
  userId: string | bigint,
): Promise<boolean> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);

  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, bid),
  });
  if (!bridge || bridge.ownerId === uid) return false;

  const deleted = await db
    .delete(bridgeMembersTable)
    .where(
      and(
        eq(bridgeMembersTable.bridgeId, bid),
        eq(bridgeMembersTable.userId, uid),
      ),
    )
    .returning({ userId: bridgeMembersTable.userId });

  if (deleted.length === 0) return false;

  AppBridgePeer.removeRecipient(bid.toString(), uid.toString());

  fireAndForget(() =>
    emitEvent({
      event: "BridgeMemberRemove",
      user_id: uid.toString(),
      data: { bridgeId: bid.toString() },
    }),
  );

  return true;
};

export const removeAllMembershipsForUser = async (
  userId: string | bigint,
): Promise<void> => {
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  const rows = await db
    .delete(bridgeMembersTable)
    .where(eq(bridgeMembersTable.userId, uid))
    .returning({ bridgeId: bridgeMembersTable.bridgeId });

  for (const row of rows) {
    AppBridgePeer.removeRecipient(row.bridgeId.toString(), uid.toString());
    fireAndForget(() =>
      emitEvent({
        event: "BridgeMemberRemove",
        user_id: uid.toString(),
        data: { bridgeId: row.bridgeId.toString() },
      }),
    );
  }
};

/** Owner + explicit member rows, deduped. */
export const listMemberUserIds = async (
  bridgeId: string | bigint,
): Promise<string[]> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, bid),
  });
  if (!bridge) return [];

  const members = await db.query.bridgeMembersTable.findMany({
    where: eq(bridgeMembersTable.bridgeId, bid),
  });

  const ids = new Set<string>([bridge.ownerId.toString()]);
  for (const m of members) ids.add(m.userId.toString());
  return [...ids];
};

export const isBridgeMember = async (
  bridgeId: string | bigint,
  userId: string | bigint,
): Promise<boolean> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  const row = await db.query.bridgeMembersTable.findFirst({
    where: and(
      eq(bridgeMembersTable.bridgeId, bid),
      eq(bridgeMembersTable.userId, uid),
    ),
  });
  return Boolean(row);
};
