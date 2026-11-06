import {
  bridgeBanServersTable,
  bridgeBansTable,
  db,
  minecraftInventoriesTable,
  minecraftLinksTable,
} from "@mutualzz/database";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { playersForBridge } from "./OnlinePlayers";
import { moderateOnServers } from "./Moderation";

export const resolvePlayerName = async (
  bridgeId: string,
  minecraftUuid: string,
) => {
  const uuid = minecraftUuid.toLowerCase();

  const online = playersForBridge(bridgeId).find(
    (player) => player.uuid.toLowerCase() === uuid,
  );
  if (online) return online.name;

  const snapshot = await db.query.minecraftInventoriesTable.findFirst({
    where: and(
      eq(minecraftInventoriesTable.bridgeId, BigInt(bridgeId)),
      eq(minecraftInventoriesTable.minecraftUuid, uuid),
    ),
    columns: { minecraftName: true },
    orderBy: desc(minecraftInventoriesTable.capturedAt),
  });
  if (snapshot) return snapshot.minecraftName;

  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.minecraftUuid, uuid),
    columns: { minecraftName: true },
  });
  return link?.minecraftName ?? null;
};

export const isBannedFromBridge = async (
  bridgeId: bigint,
  minecraftUuid: string,
) => {
  const ban = await db.query.bridgeBansTable.findFirst({
    where: and(
      eq(bridgeBansTable.bridgeId, bridgeId),
      eq(bridgeBansTable.minecraftUuid, minecraftUuid.toLowerCase()),
      isNull(bridgeBansTable.liftedAt),
    ),
    columns: { id: true },
  });
  return Boolean(ban);
};

export const markBanApplied = async (banId: bigint, serverIds: string[]) => {
  if (serverIds.length === 0) return;
  await db
    .insert(bridgeBanServersTable)
    .values(serverIds.map((serverId) => ({ banId, serverId })))
    .onConflictDoNothing();
};

export const markBanRemoved = async (banId: bigint, serverIds: string[]) => {
  if (serverIds.length === 0) return;
  await db
    .delete(bridgeBanServersTable)
    .where(
      and(
        eq(bridgeBanServersTable.banId, banId),
        inArray(bridgeBanServersTable.serverId, serverIds),
      ),
    );
};

export const deleteBanIfFullyLifted = async (banId: bigint) => {
  const remaining = await db.query.bridgeBanServersTable.findFirst({
    where: eq(bridgeBanServersTable.banId, banId),
    columns: { serverId: true },
  });
  if (remaining) return;
  await db
    .delete(bridgeBansTable)
    .where(
      and(eq(bridgeBansTable.id, banId), isNotNull(bridgeBansTable.liftedAt)),
    );
};

export const syncBansForServer = async (bridgeId: string, serverId: string) => {
  const bans = await db
    .select({
      id: bridgeBansTable.id,
      minecraftUuid: bridgeBansTable.minecraftUuid,
      minecraftName: bridgeBansTable.minecraftName,
      reason: bridgeBansTable.reason,
      liftedAt: bridgeBansTable.liftedAt,
      appliedOn: bridgeBanServersTable.serverId,
    })
    .from(bridgeBansTable)
    .leftJoin(
      bridgeBanServersTable,
      and(
        eq(bridgeBanServersTable.banId, bridgeBansTable.id),
        eq(bridgeBanServersTable.serverId, serverId),
      ),
    )
    .where(eq(bridgeBansTable.bridgeId, BigInt(bridgeId)));

  for (const ban of bans) {
    const applied = ban.appliedOn !== null;
    const target = {
      uuid: ban.minecraftUuid,
      name: ban.minecraftName,
      reason: ban.reason ?? undefined,
    };

    if (!ban.liftedAt && !applied) {
      const [result] = await moderateOnServers(
        bridgeId,
        [serverId],
        "ban",
        target,
      );
      if (result?.ok) await markBanApplied(ban.id, [serverId]);
    } else if (ban.liftedAt && applied) {
      const [result] = await moderateOnServers(
        bridgeId,
        [serverId],
        "unban",
        target,
      );
      if (result?.ok) {
        await markBanRemoved(ban.id, [serverId]);
        await deleteBanIfFullyLifted(ban.id);
      }
    }
  }
};
