import { bridgeMinecraftServersTable, db } from "@mutualzz/database";
import { Logger } from "@mutualzz/logger";
import { and, eq } from "drizzle-orm";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { VoiceStateService } from "../gateway/voice/VoiceState.service";
import { publishBridgeEvent } from "./BridgeBus";
import { clearInFlightForSession } from "./InventoryEdits.ts";
import { clearServerPlayers, playersForBridge } from "./OnlinePlayers";
import { clearServerStatus } from "./ServerStatuses.ts";
import { getSession, sendToSocket, unregisterSession } from "./SessionRegistry";
import type { MinecraftPayload } from "./types";
import {
  handleChat,
  handleGameEvent,
  handlePlayerEvent,
  handleServerStatus,
} from "./handlers/events";
import { handleIdentify } from "./handlers/identify";
import {
  handleEditResult,
  handleInventory,
  inOrder,
} from "./handlers/inventory";
import { handleLink } from "./handlers/link";
import { handleModerationResult } from "./handlers/moderation";
import { findLinkByUuid, syncMinecraftPresence } from "./handlers/shared";
import {
  handleVoiceJoin,
  handleVoiceLeave,
  handleVoiceState,
} from "./handlers/voice";

const logger = new Logger({ tag: "MinecraftWS" });

const HEARTBEAT_INTERVAL = 15_000;
const HEARTBEAT_TIMEOUT = 45_000;

const touchServerLastSeen = async (bridgeId: string, serverId: string) => {
  await db
    .update(bridgeMinecraftServersTable)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(bridgeMinecraftServersTable.bridgeId, BigInt(bridgeId)),
        eq(bridgeMinecraftServersTable.serverId, serverId),
      ),
    );
};

const parsePayload = (raw: WebSocket.RawData): MinecraftPayload | null => {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.from(raw).toString("utf8");
    return JSON.parse(text) as MinecraftPayload;
  } catch {
    return null;
  }
};

export const onMinecraftConnection = (
  socket: WebSocket,
  _req: IncomingMessage,
) => {
  let identified = false;

  sendToSocket(socket, {
    op: "hello",
    d: { heartbeatInterval: HEARTBEAT_INTERVAL },
  });

  const heartbeatTimer = setInterval(() => {
    const session = getSession(socket);
    if (!session) return;
    if (Date.now() - session.lastHeartbeatAt > HEARTBEAT_TIMEOUT) {
      logger.warn(`Heartbeat timeout for session ${session.sessionId}`);
      socket.close(4000, "Heartbeat timeout");
    }
  }, HEARTBEAT_INTERVAL);

  socket.on("message", async (raw) => {
    const payload = parsePayload(raw);
    if (!payload?.op) {
      sendToSocket(socket, {
        op: "error",
        d: { code: "invalid_payload", message: "Invalid JSON payload" },
      });
      return;
    }

    try {
      if (payload.op === "identify") {
        if (identified) {
          sendToSocket(socket, {
            op: "error",
            d: {
              code: "already_identified",
              message: "Already identified",
            },
          });
          return;
        }
        await handleIdentify(socket, payload);
        identified = !!getSession(socket);
        return;
      }

      const session = getSession(socket);
      if (!session) {
        sendToSocket(socket, {
          op: "error",
          d: {
            code: "not_identified",
            message: "Send identify first",
          },
        });
        return;
      }

      session.lastHeartbeatAt = Date.now();

      switch (payload.op) {
        case "heartbeat":
          sendToSocket(socket, { op: "heartbeat_ack" });
          void touchServerLastSeen(session.bridgeId, session.serverId);
          break;
        case "chat":
          await handleChat(session, payload);
          break;
        case "join":
          await handlePlayerEvent(session, payload, "JOIN");
          break;
        case "leave":
          await handlePlayerEvent(session, payload, "LEAVE");
          break;
        case "link":
          await handleLink(session, payload);
          break;
        case "voice_join":
          await handleVoiceJoin(session, payload);
          break;
        case "voice_leave":
          await handleVoiceLeave(session, payload);
          break;
        case "voice_state":
          await handleVoiceState(session, payload);
          break;
        case "inventory":
          await inOrder(session, () => handleInventory(session, payload));
          break;
        case "game_event":
          await handleGameEvent(session, payload);
          break;
        case "server_status":
          await handleServerStatus(session, payload);
          break;
        case "moderation_result":
          handleModerationResult(session, payload);
          break;
        case "inventory_edit_results":
          await inOrder(session, () => handleEditResult(session, payload));
          break;
        default:
          sendToSocket(socket, {
            op: "error",
            d: {
              code: "unknown_op",
              message: `Unknown op: ${String(payload.op)}`,
            },
          });
      }
    } catch (error) {
      logger.error(`Handler error: ${error}`);
      sendToSocket(socket, {
        op: "error",
        d: { code: "internal", message: "Internal error" },
      });
    }
  });

  socket.on("close", async () => {
    clearInterval(heartbeatTimer);
    const session = getSession(socket);
    if (session) {
      const removed = clearServerPlayers(session.bridgeId, session.serverId);
      for (const player of removed) {
        const link = await findLinkByUuid(player.uuid);
        if (link) {
          await VoiceStateService.leaveFromMinecraft(
            link.userId.toString(),
          ).catch((err) =>
            logger.debug(`voice clear on disconnect failed: ${err}`),
          );
        }
        void syncMinecraftPresence(
          player.uuid,
          session.bridgeId,
          session.serverId,
          "LEAVE",
        ).catch((err) =>
          logger.debug(`presence clear on disconnect failed: ${err}`),
        );
      }
      clearServerStatus(session.bridgeId, session.serverId);
      clearInFlightForSession(session);
      await publishBridgeEvent({
        type: "SERVER_STATUS",
        bridgeId: session.bridgeId,
        sourceId: session.sessionId,
        data: {
          bridgeId: session.bridgeId,
          serverId: session.serverId,
          status: null,
        },
      });
      await publishBridgeEvent({
        type: "PRESENCE",
        bridgeId: session.bridgeId,
        sourceId: session.sessionId,
        data: {
          bridgeId: session.bridgeId,
          players: playersForBridge(session.bridgeId),
        },
      });
    }
    await unregisterSession(socket);
  });

  socket.on("error", (error) => {
    logger.error(`Socket error: ${error}`);
  });
};
