import type { WebSocket } from "ws";
import { subscribeBridge } from "./BridgeBus";
import type { BridgeEvent, MinecraftPayload } from "./types";

export interface MinecraftSession {
  socket: WebSocket;
  sessionId: string;
  bridgeId: string;
  serverId: string;
  tokenId: string;
  lastHeartbeatAt: number;
  readyAt: number;
}

const sessions = new Map<WebSocket, MinecraftSession>();
const byBridge = new Map<string, Set<MinecraftSession>>();
const bridgeUnsubscribers = new Map<string, () => void>();

export const getSession = (socket: WebSocket) => sessions.get(socket);

export const registerSession = (session: MinecraftSession) => {
  sessions.set(session.socket, session);
  const set = byBridge.get(session.bridgeId) ?? new Set();
  set.add(session);
  byBridge.set(session.bridgeId, set);

  if (!bridgeUnsubscribers.has(session.bridgeId)) {
    const unsubscribe = subscribeBridge(session.bridgeId, (event) => {
      dispatchToBridgePlugins(event);
    });
    bridgeUnsubscribers.set(session.bridgeId, unsubscribe);
  }
};

export const unregisterSession = async (socket: WebSocket) => {
  const session = sessions.get(socket);
  if (!session) return;
  sessions.delete(socket);
  const set = byBridge.get(session.bridgeId);
  if (set) {
    set.delete(session);
    if (set.size === 0) {
      byBridge.delete(session.bridgeId);
      bridgeUnsubscribers.get(session.bridgeId)?.();
      bridgeUnsubscribers.delete(session.bridgeId);
    }
  }
};

export const sessionsForBridge = (bridgeId: string) =>
  byBridge.get(bridgeId) ?? new Set<MinecraftSession>();

export const isBridgeOnline = (bridgeId: string) =>
  sessionsForBridge(bridgeId).size > 0;

export const connectedServerIds = (bridgeId: string) => [
  ...new Set([...sessionsForBridge(bridgeId)].map((s) => s.serverId)),
];

export const sendToSocket = (socket: WebSocket, payload: MinecraftPayload) => {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
};

export const dispatchToBridgePlugins = (event: BridgeEvent) => {
  for (const session of sessionsForBridge(event.bridgeId)) {
    // Don't echo back to the Minecraft connection that produced the event.
    // sourceId may be "sessionId" or "sessionId:messageId".
    if (
      event.sourceId &&
      (session.sessionId === event.sourceId ||
        event.sourceId.startsWith(`${session.sessionId}:`))
    ) {
      continue;
    }
    sendToSocket(session.socket, {
      op: "dispatch",
      t: event.type,
      d: event.data as Record<string, unknown>,
    });
  }
};
