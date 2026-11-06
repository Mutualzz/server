import { randomUUID } from "node:crypto";
import {
  sendToSocket,
  sessionsForBridge,
  type MinecraftSession,
} from "./SessionRegistry";

export type ModerationAction = "kick" | "ban" | "unban";

export interface ModerationTarget {
  uuid: string;
  name: string;
  reason?: string;
}

export interface ModerationResult {
  serverId: string;
  ok: boolean;
  message: string;
}

const RESPONSE_TIMEOUT_MS = 5_000;

const pending = new Map<
  string,
  {
    session: MinecraftSession;
    settle: (result: { ok: boolean; message: string }) => void;
  }
>();

const requestOnSession = (
  session: MinecraftSession,
  action: ModerationAction,
  target: ModerationTarget,
) =>
  new Promise<ModerationResult>((resolve) => {
    if (!session.remoteModeration) {
      resolve({
        serverId: session.serverId,
        ok: false,
        message: "Remote moderation is disabled on this server",
      });
      return;
    }

    const requestId = randomUUID();
    const settle = (result: { ok: boolean; message: string }) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ serverId: session.serverId, ...result });
    };
    const timer = setTimeout(
      () => settle({ ok: false, message: "The server did not respond" }),
      RESPONSE_TIMEOUT_MS,
    );

    pending.set(requestId, { session, settle });
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "MODERATE",
      d: {
        requestId,
        serverId: session.serverId,
        action,
        uuid: target.uuid,
        name: target.name,
        reason: target.reason ?? "",
      },
    });
  });

export const resolveModerationResult = (
  session: MinecraftSession,
  requestId: string,
  result: { ok: boolean; message: string },
) => {
  const entry = pending.get(requestId);
  if (!entry || entry.session !== session) return;
  entry.settle(result);
};

export const moderateOnServers = (
  bridgeId: string,
  serverIds: string[] | "all",
  action: ModerationAction,
  target: ModerationTarget,
) => {
  const sessions = [...sessionsForBridge(bridgeId)].filter(
    (session) => serverIds === "all" || serverIds.includes(session.serverId),
  );
  return Promise.all(
    sessions.map((session) => requestOnSession(session, action, target)),
  );
};

export const moderationServerIds = (bridgeId: string) =>
  [...sessionsForBridge(bridgeId)]
    .filter((session) => session.remoteModeration)
    .map((session) => session.serverId);
