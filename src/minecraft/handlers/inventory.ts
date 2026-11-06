import {
  minecraftInventoryData,
  minecraftInventoryEditResultsData,
} from "@mutualzz/validators";
import { saveInventorySnapshot } from "../Inventories.ts";
import { handleInventoryEditResults } from "../InventoryEdits.ts";
import type { MinecraftSession } from "../SessionRegistry";
import type { MinecraftPayload } from "../types";
import { parseData } from "./shared";

const inventoryQueues = new WeakMap<MinecraftSession, Promise<unknown>>();

export const inOrder = (
  session: MinecraftSession,
  task: () => Promise<void>,
) => {
  const next = (inventoryQueues.get(session) ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);
  inventoryQueues.set(session, next);
  return next;
};

export const handleInventory = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const snapshot = parseData(session.socket, payload, minecraftInventoryData);
  if (!snapshot) return;
  await saveInventorySnapshot(session.bridgeId, session.serverId, snapshot);
};

export const handleEditResult = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const data = parseData(
    session.socket,
    payload,
    minecraftInventoryEditResultsData,
  );
  if (!data) return;
  await handleInventoryEditResults(session, data);
};
