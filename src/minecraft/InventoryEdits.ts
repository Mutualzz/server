import {
  bridgeMinecraftServersTable,
  db,
  minecraftInventoriesTable,
  minecraftInventoryEditsTable,
} from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { emitEvent, fireAndForget, Snowflake } from "@mutualzz/util";
import type {
  InventoryEditExpected,
  InventoryEditOp,
  InventorySlotIntent,
  minecraftInventoryEditResultsData,
} from "@mutualzz/validators";
import { and, asc, eq, gt, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { saveInventorySnapshot, type SerializedInventory } from "./Inventories";
import { inventoryViewers } from "./InventoryViewers";
import { playersForBridge } from "./OnlinePlayers";
import {
  sendToSocket,
  sessionsForBridge,
  type MinecraftSession,
} from "./SessionRegistry";

const logger = new Logger({ tag: "InventoryEdits" });

type EditRow = typeof minecraftInventoryEditsTable.$inferSelect;

interface SlotRef {
  container: "inventory" | "enderChest";
  slot: number;
}

const MAX_PENDING_EDITS = 50;
const DELIVERY_TIMEOUT_MS = 10_000;

const inFlight = new Map<
  string,
  {
    batchId: string;
    bridgeId: string;
    serverId: string;
    uuid: string;
    editIds: Set<string>;
    session: MinecraftSession;
    timer: NodeJS.Timeout;
  }
>();

const playerKey = (bridgeId: string, serverId: string, uuid: string) =>
  `${bridgeId}:${serverId}:${uuid}`;

export class InventoryEditError extends Error {}

export const slotKey = (ref: SlotRef) => `${ref.container}:${ref.slot}`;

const touchedSlots = (op: InventoryEditOp): SlotRef[] =>
  op.kind === "move" ? [op.from, op.to] : [op];

const playerWhere = (bridgeId: bigint, serverId: string, uuid: string) => ({
  inventory: and(
    eq(minecraftInventoriesTable.bridgeId, bridgeId),
    eq(minecraftInventoriesTable.serverId, serverId),
    eq(minecraftInventoriesTable.minecraftUuid, uuid),
  ),
  pending: and(
    eq(minecraftInventoryEditsTable.bridgeId, bridgeId),
    eq(minecraftInventoryEditsTable.serverId, serverId),
    eq(minecraftInventoryEditsTable.minecraftUuid, uuid),
    eq(minecraftInventoryEditsTable.status, "pending"),
  ),
});

export const pendingEditsFor = (
  bridgeId: bigint,
  serverId: string,
  uuid: string,
) =>
  db.query.minecraftInventoryEditsTable.findMany({
    where: playerWhere(bridgeId, serverId, uuid).pending,
    orderBy: asc(minecraftInventoryEditsTable.id),
  });

export const pendingEditsForPlayer = (bridgeId: bigint, uuid: string) =>
  db.query.minecraftInventoryEditsTable.findMany({
    where: and(
      eq(minecraftInventoryEditsTable.bridgeId, bridgeId),
      eq(minecraftInventoryEditsTable.minecraftUuid, uuid),
      eq(minecraftInventoryEditsTable.status, "pending"),
    ),
    orderBy: asc(minecraftInventoryEditsTable.id),
  });

const projectInventory = async (
  bridgeId: bigint,
  serverId: string,
  uuid: string,
) => {
  const [snapshot, pending] = await Promise.all([
    db.query.minecraftInventoriesTable.findFirst({
      where: playerWhere(bridgeId, serverId, uuid).inventory,
    }),
    pendingEditsFor(bridgeId, serverId, uuid),
  ]);
  if (!snapshot) return null;

  const state = new Map<string, InventorySlotIntent | null>();
  const intentOf = (item: { type: string; data?: string }) => ({
    type: item.type,
    ...(item.data && { data: item.data }),
  });
  for (const item of snapshot.inventory) {
    state.set(`inventory:${item.slot}`, intentOf(item));
  }
  for (const item of snapshot.enderChest) {
    state.set(`enderChest:${item.slot}`, intentOf(item));
  }
  const read = (key: string) => state.get(key) ?? null;

  for (const { op } of pending) {
    if (op.kind === "move") {
      const from = slotKey(op.from);
      const to = slotKey(op.to);
      const moving = read(from);
      state.set(from, read(to));
      state.set(to, moving);
    } else if (op.kind === "remove") {
      state.set(slotKey(op), null);
    } else if (op.kind === "give") {
      state.set(slotKey(op), { type: op.type });
    } else {
      const current = read(slotKey(op));
      state.set(slotKey(op), current && { type: current.type });
    }
  }

  return { read, pendingCount: pending.length };
};

export const createInventoryEdit = async (input: {
  bridgeId: bigint;
  serverId: string;
  minecraftUuid: string;
  op: InventoryEditOp;
  createdById: bigint;
}) => {
  const { bridgeId, serverId, minecraftUuid, op } = input;

  const server = await db.query.bridgeMinecraftServersTable.findFirst({
    where: and(
      eq(bridgeMinecraftServersTable.bridgeId, bridgeId),
      eq(bridgeMinecraftServersTable.serverId, serverId),
    ),
    columns: { remoteInventoryEdit: true },
  });
  if (!server) throw new InventoryEditError("Unknown server");
  if (!server.remoteInventoryEdit) {
    throw new InventoryEditError(
      "Inventory editing is disabled on this server (remoteInventoryEdit in the plugin config)",
    );
  }

  const projected = await projectInventory(bridgeId, serverId, minecraftUuid);
  if (!projected) {
    throw new InventoryEditError(
      "No inventory snapshot for this player on that server",
    );
  }
  if (projected.pendingCount >= MAX_PENDING_EDITS) {
    throw new InventoryEditError("Too many pending edits for this player");
  }
  if (op.kind === "move" && slotKey(op.from) === slotKey(op.to)) {
    throw new InventoryEditError("Same slot");
  }

  const expected: InventoryEditExpected = {};
  for (const ref of touchedSlots(op)) {
    expected[slotKey(ref)] = projected.read(slotKey(ref));
  }

  const mainSlot = slotKey(op.kind === "move" ? op.from : op);
  if (op.kind === "give" && expected[mainSlot] !== null) {
    throw new InventoryEditError("That slot is not empty");
  }
  if (op.kind !== "give" && expected[mainSlot] === null) {
    throw new InventoryEditError("That slot is empty");
  }

  const [edit] = await db
    .insert(minecraftInventoryEditsTable)
    .values({
      id: BigInt(Snowflake.generate()),
      bridgeId,
      serverId,
      minecraftUuid,
      op,
      expected,
      createdById: input.createdById,
    })
    .returning();

  const bridgeIdString = bridgeId.toString();
  emitEditUpdates(bridgeIdString, minecraftUuid, [edit]);
  void deliverPendingEdits(bridgeIdString, serverId, minecraftUuid).catch(
    (error) => logger.error(`Edit delivery failed: ${error}`),
  );
  return edit;
};

export const serializeInventoryEdit = (
  edit: typeof minecraftInventoryEditsTable.$inferSelect,
) => ({
  id: edit.id.toString(),
  serverId: edit.serverId,
  minecraftUuid: edit.minecraftUuid,
  op: edit.op,
  status: edit.status,
  message: edit.message,
  createdAt: edit.createdAt,
  resolvedAt: edit.resolvedAt,
});

const emitEditUpdates = (
  bridgeId: string,
  minecraftUuid: string,
  edits: EditRow[],
  inventory?: (SerializedInventory & { bridgeId: string }) | null,
) => {
  if (edits.length === 0 && !inventory) return;
  const data = {
    bridgeId,
    minecraftUuid,
    edits: edits.map(serializeInventoryEdit),
    ...(inventory && { inventory }),
  };
  for (const userId of inventoryViewers(bridgeId, minecraftUuid)) {
    fireAndForget(() =>
      emitEvent({
        event: "BridgeInventoryEditUpdate",
        user_id: userId,
        data,
      }),
    );
  }
};

export const deliverPendingEdits = async (
  bridgeId: string,
  serverId: string,
  uuid: string,
) => {
  const key = playerKey(bridgeId, serverId, uuid);
  if (inFlight.has(key)) return;

  const session = [...sessionsForBridge(bridgeId)].find(
    (candidate) =>
      candidate.serverId === serverId && candidate.remoteInventoryEdit,
  );
  if (!session) return;

  const online = playersForBridge(bridgeId).some(
    (player) => player.uuid === uuid && player.serverId === serverId,
  );
  if (!online) return;

  const edits = await pendingEditsFor(BigInt(bridgeId), serverId, uuid);
  if (edits.length === 0 || inFlight.has(key)) return;

  const batchId = randomUUID();
  const timer = setTimeout(() => {
    if (inFlight.get(key)?.batchId !== batchId) return;
    inFlight.delete(key);
    void deliverPendingEdits(bridgeId, serverId, uuid).catch((error) =>
      logger.error(`Edit redelivery failed for ${key}: ${error}`),
    );
  }, DELIVERY_TIMEOUT_MS);

  inFlight.set(key, {
    batchId,
    bridgeId,
    serverId,
    uuid,
    editIds: new Set(edits.map((edit) => edit.id.toString())),
    session,
    timer,
  });

  sendToSocket(session.socket, {
    op: "dispatch",
    t: "INVENTORY_EDIT_BATCH",
    d: {
      batchId,
      serverId,
      uuid,
      edits: edits.map((edit) => ({
        editId: edit.id.toString(),
        op: edit.op,
        expected: edit.expected,
      })),
    },
  });
};

const resolveEdit = async (editId: string, ok: boolean, message: string) => {
  const [row] = await db
    .update(minecraftInventoryEditsTable)
    .set({
      status: ok ? "applied" : "rejected",
      message: message || null,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(minecraftInventoryEditsTable.id, BigInt(editId)),
        eq(minecraftInventoryEditsTable.status, "pending"),
      ),
    )
    .returning();
  return row;
};

const rejectLaterEdits = (edit: EditRow) =>
  db
    .update(minecraftInventoryEditsTable)
    .set({
      status: "rejected",
      message: "An earlier edit failed",
      resolvedAt: new Date(),
    })
    .where(
      and(
        playerWhere(edit.bridgeId, edit.serverId, edit.minecraftUuid).pending,
        gt(minecraftInventoryEditsTable.id, edit.id),
      ),
    )
    .returning();

export const handleInventoryEditResults = async (
  session: MinecraftSession,
  result: z.output<typeof minecraftInventoryEditResultsData>,
) => {
  const entry = [...inFlight].find(
    ([, flight]) =>
      flight.batchId === result.batchId && flight.session === session,
  );
  if (!entry) return;
  const [key, flight] = entry;
  const { bridgeId, serverId, uuid } = flight;
  clearTimeout(flight.timer);

  try {
    const inventory =
      result.inventory?.uuid === uuid
        ? await saveInventorySnapshot(bridgeId, serverId, result.inventory, {
            emit: false,
          })
        : null;

    if (result.retry) return;

    const resolved = await Promise.all(
      result.results
        .filter((entry) => flight.editIds.has(entry.editId))
        .map((entry) => resolveEdit(entry.editId, entry.ok, entry.message)),
    );
    const updated = resolved.filter((row): row is EditRow => Boolean(row));

    const firstRejected = updated.find((row) => row.status === "rejected");
    if (firstRejected) updated.push(...(await rejectLaterEdits(firstRejected)));

    emitEditUpdates(bridgeId, uuid, updated, inventory);
  } finally {
    inFlight.delete(key);
  }

  if (!result.retry) await deliverPendingEdits(bridgeId, serverId, uuid);
};

export const cancelInventoryEdit = async (bridgeId: bigint, editId: bigint) => {
  const edit = await db.query.minecraftInventoryEditsTable.findFirst({
    where: and(
      eq(minecraftInventoryEditsTable.id, editId),
      eq(minecraftInventoryEditsTable.bridgeId, bridgeId),
      eq(minecraftInventoryEditsTable.status, "pending"),
    ),
  });
  if (!edit) {
    throw new InventoryEditError("Edit not found or already finished");
  }

  const key = playerKey(bridgeId.toString(), edit.serverId, edit.minecraftUuid);
  if (inFlight.get(key)?.editIds.has(edit.id.toString())) {
    throw new InventoryEditError("That edit is being applied right now");
  }

  const rows = await db
    .update(minecraftInventoryEditsTable)
    .set({ status: "cancelled", resolvedAt: new Date() })
    .where(
      and(
        playerWhere(bridgeId, edit.serverId, edit.minecraftUuid).pending,
        gte(minecraftInventoryEditsTable.id, edit.id),
      ),
    )
    .returning();
  emitEditUpdates(bridgeId.toString(), edit.minecraftUuid, rows);
  return rows.length;
};

export const clearInFlightForSession = (session: MinecraftSession) => {
  for (const [key, flight] of inFlight) {
    if (flight.session !== session) continue;
    clearTimeout(flight.timer);
    inFlight.delete(key);
  }
};
