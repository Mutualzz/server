import {
  bridgeMembersTable,
  bridgesTable,
  db,
  spaceMembersTable,
} from "@mutualzz/database";
import { emitEvent, fireAndForget, requireSpacePermissions } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import { AppBridgePeer } from "./AppBridgePeer";

export type BridgeRole = "admin" | "member";

export const userCanManageBridge = async (
  userId: string | bigint,
  bridge: { spaceId: bigint },
) => {
  try {
    await requireSpacePermissions({
      spaceId: bridge.spaceId.toString(),
      userId: typeof userId === "bigint" ? userId.toString() : userId,
      needed: ["ManageSpace"],
    });
    return true;
  } catch {
    return false;
  }
};

export const userIsSpaceMember = async (
  userId: string | bigint,
  spaceId: bigint,
) => {
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  const row = await db.query.spaceMembersTable.findFirst({
    where: and(
      eq(spaceMembersTable.spaceId, spaceId),
      eq(spaceMembersTable.userId, uid),
    ),
  });
  return Boolean(row);
};

export const bridgeRoleForUser = async (
  userId: string | bigint,
  bridge: { spaceId: bigint },
  isBridgeMember: boolean,
): Promise<BridgeRole | null> => {
  if (await userCanManageBridge(userId, bridge)) return "admin";
  if (isBridgeMember) return "member";
  if (await userIsSpaceMember(userId, bridge.spaceId)) return "member";
  return null;
};

export const userCanAccessBridge = async (
  userId: string | bigint,
  bridge: { spaceId: bigint },
  isBridgeMember: boolean,
) => Boolean(await bridgeRoleForUser(userId, bridge, isBridgeMember));

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

  if (await userIsSpaceMember(uid, bridge.spaceId)) return false;

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
        spaceId: bridge.spaceId.toString(),
        name: bridge.name,
        role: "member" as const,
      },
    }),
  );

  return true;
};

export const removeMember = async (
  bridgeId: string | bigint,
  userId: string | bigint,
): Promise<boolean> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);

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

export const listMemberUserIds = async (
  bridgeId: string | bigint,
): Promise<string[]> => {
  const bid = typeof bridgeId === "bigint" ? bridgeId : BigInt(bridgeId);
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, bid),
  });
  if (!bridge) return [];

  const [spaceMembers, bridgeMembers] = await Promise.all([
    db.query.spaceMembersTable.findMany({
      where: eq(spaceMembersTable.spaceId, bridge.spaceId),
    }),
    db.query.bridgeMembersTable.findMany({
      where: eq(bridgeMembersTable.bridgeId, bid),
    }),
  ]);

  const ids = new Set<string>();
  for (const m of spaceMembers) ids.add(m.userId.toString());
  for (const m of bridgeMembers) ids.add(m.userId.toString());
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
