export interface OnlineMinecraftPlayer {
  uuid: string;
  name: string;
  serverId: string;
}

/** uuid → player, scoped by bridgeId */
const byBridge = new Map<string, Map<string, OnlineMinecraftPlayer>>();

export const playersForBridge = (bridgeId: string): OnlineMinecraftPlayer[] => [
  ...(byBridge.get(bridgeId)?.values() ?? []),
];

export const playerJoined = (
  bridgeId: string,
  player: OnlineMinecraftPlayer,
) => {
  const map = byBridge.get(bridgeId) ?? new Map();
  map.set(player.uuid, player);
  byBridge.set(bridgeId, map);
};

export const playerLeft = (bridgeId: string, uuid: string) => {
  const map = byBridge.get(bridgeId);
  if (!map) return;
  map.delete(uuid);
  if (map.size === 0) byBridge.delete(bridgeId);
};

export const findOnlinePlayer = (
  uuid: string,
): { bridgeId: string; player: OnlineMinecraftPlayer } | null => {
  const matches = findOnlineBridgesForUuid(uuid);
  return matches[0] ?? null;
};

/** All bridges where this Minecraft UUID is currently online. */
export const findOnlineBridgesForUuid = (
  uuid: string,
): { bridgeId: string; player: OnlineMinecraftPlayer }[] => {
  const id = uuid.trim().toLowerCase();
  const out: { bridgeId: string; player: OnlineMinecraftPlayer }[] = [];
  for (const [bridgeId, map] of byBridge) {
    for (const [key, player] of map) {
      if (key.toLowerCase() === id || player.uuid.toLowerCase() === id) {
        out.push({ bridgeId, player });
        break;
      }
    }
  }
  return out;
};

export const clearServerPlayers = (
  bridgeId: string,
  serverId: string,
): OnlineMinecraftPlayer[] => {
  const map = byBridge.get(bridgeId);
  if (!map) return [];
  const removed: OnlineMinecraftPlayer[] = [];
  for (const [uuid, player] of map) {
    if (player.serverId === serverId) {
      map.delete(uuid);
      removed.push(player);
    }
  }
  if (map.size === 0) byBridge.delete(bridgeId);
  return removed;
};
