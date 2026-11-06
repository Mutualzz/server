import { db, minecraftInventoriesTable } from "@mutualzz/database";
import { emitEvent, fireAndForget, Snowflake } from "@mutualzz/util";
import type { MinecraftInventoryData } from "@mutualzz/validators";
import { inventoryViewers } from "./InventoryViewers";

export const serializeInventory = (
  row: typeof minecraftInventoriesTable.$inferSelect,
) => ({
  serverId: row.serverId,
  minecraftUuid: row.minecraftUuid,
  minecraftName: row.minecraftName,
  inventory: row.inventory.map(({ data, ...slot }) => slot),
  enderChest: row.enderChest.map(({ data, ...slot }) => slot),
  capturedAt: row.capturedAt,
});

export type SerializedInventory = ReturnType<typeof serializeInventory>;

export const emitInventoryUpdate = (
  userId: string,
  data: SerializedInventory & { bridgeId: string },
) => {
  fireAndForget(() =>
    emitEvent({
      event: "BridgeInventoryUpdate",
      user_id: userId,
      data,
    }),
  );
};

export const saveInventorySnapshot = async (
  bridgeId: string,
  serverId: string,
  snapshot: MinecraftInventoryData,
  { emit = true }: { emit?: boolean } = {},
) => {
  const capturedAt = new Date();

  const [row] = await db
    .insert(minecraftInventoriesTable)
    .values({
      id: BigInt(Snowflake.generate()),
      bridgeId: BigInt(bridgeId),
      serverId,
      minecraftUuid: snapshot.uuid,
      minecraftName: snapshot.name,
      inventory: snapshot.inventory,
      enderChest: snapshot.enderChest,
      capturedAt,
    })
    .onConflictDoUpdate({
      target: [
        minecraftInventoriesTable.bridgeId,
        minecraftInventoriesTable.serverId,
        minecraftInventoriesTable.minecraftUuid,
      ],
      set: {
        minecraftName: snapshot.name,
        inventory: snapshot.inventory,
        enderChest: snapshot.enderChest,
        capturedAt,
      },
    })
    .returning();

  if (!row) return null;

  const update = { bridgeId, ...serializeInventory(row) };
  if (emit) {
    for (const userId of inventoryViewers(bridgeId, snapshot.uuid)) {
      emitInventoryUpdate(userId, update);
    }
  }
  return update;
};
