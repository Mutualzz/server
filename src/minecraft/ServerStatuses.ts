import type { BridgeServerStatus } from "./types";

const statuses = new Map<string, Map<string, BridgeServerStatus>>();

export const setServerStatus = (
  bridgeId: string,
  status: BridgeServerStatus,
) => {
  const map = statuses.get(bridgeId) ?? new Map<string, BridgeServerStatus>();
  map.set(status.serverId, status);
  statuses.set(bridgeId, map);
};

export const clearServerStatus = (bridgeId: string, serverId: string) => {
  const map = statuses.get(bridgeId);
  if (!map) return;
  map.delete(serverId);
  if (map.size === 0) statuses.delete(bridgeId);
};

export const serverStatusesForBridge = (
  bridgeId: string,
): BridgeServerStatus[] => [...(statuses.get(bridgeId)?.values() ?? [])];
