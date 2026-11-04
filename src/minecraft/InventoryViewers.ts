import { playersForBridge } from "./OnlinePlayers";
import { sendToSocket, sessionsForBridge } from "./SessionRegistry";

const RENEW_INTERVAL_MS = 15_000;

interface WatchedPlayer {
  bridgeId: string;
  minecraftUuid: string;
  viewers: Map<string, string>;
}

const watched = new Map<string, WatchedPlayer>();

const keyFor = (bridgeId: string, minecraftUuid: string) =>
  `${bridgeId}:${minecraftUuid.toLowerCase()}`;

export const addInventoryViewer = (
  bridgeId: string,
  minecraftUuid: string,
  sessionId: string,
  userId: string,
) => {
  const key = keyFor(bridgeId, minecraftUuid);
  const entry = watched.get(key) ?? {
    bridgeId,
    minecraftUuid: minecraftUuid.toLowerCase(),
    viewers: new Map<string, string>(),
  };
  entry.viewers.set(sessionId, userId);
  watched.set(key, entry);
};

export const removeInventoryViewer = (
  bridgeId: string,
  minecraftUuid: string,
  sessionId: string,
) => {
  const key = keyFor(bridgeId, minecraftUuid);
  const entry = watched.get(key);
  if (!entry) return;
  entry.viewers.delete(sessionId);
  if (entry.viewers.size === 0) watched.delete(key);
};

export const removeSessionInventoryViewers = (sessionId: string) => {
  for (const [key, entry] of watched) {
    entry.viewers.delete(sessionId);
    if (entry.viewers.size === 0) watched.delete(key);
  }
};

export const inventoryViewers = (
  bridgeId: string,
  minecraftUuid: string,
): string[] => {
  const entry = watched.get(keyFor(bridgeId, minecraftUuid));
  return entry ? [...new Set(entry.viewers.values())] : [];
};

export const requestInventoryWatch = (
  bridgeId: string,
  serverId: string,
  minecraftUuid: string,
) => {
  for (const session of sessionsForBridge(bridgeId)) {
    if (session.serverId !== serverId) continue;
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "INVENTORY_WATCH",
      d: { serverId, uuid: minecraftUuid },
    });
  }
};

export const startInventoryWatchIfViewed = (
  bridgeId: string,
  serverId: string,
  minecraftUuid: string,
) => {
  if (!watched.has(keyFor(bridgeId, minecraftUuid))) return;
  requestInventoryWatch(bridgeId, serverId, minecraftUuid);
};

const renewWatches = () => {
  for (const entry of watched.values()) {
    const online = playersForBridge(entry.bridgeId).find(
      (player) => player.uuid.toLowerCase() === entry.minecraftUuid,
    );
    if (online) {
      requestInventoryWatch(
        entry.bridgeId,
        online.serverId,
        entry.minecraftUuid,
      );
    }
  }
};

setInterval(renewWatches, RENEW_INTERVAL_MS).unref();
