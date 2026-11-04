import type { minecraftInventoriesTable } from "@mutualzz/database";
import { emitEvent, fireAndForget } from "@mutualzz/util";

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
