import { Logger } from "@mutualzz/logger";
import { RabbitMQ } from "@mutualzz/util";
import { persistBridgeEvent } from "./BridgeMessages";
import type { BridgeEvent, BridgeEventType } from "./types";

const logger = new Logger({ tag: "BridgeBus" });

const exchangeFor = (bridgeId: string) => `bridge:${bridgeId}`;

type BridgeListener = (event: BridgeEvent) => void;

const localListeners = new Map<string, Set<BridgeListener>>();

export const bridgeExchange = exchangeFor;

export const publishBridgeEvent = async (
  event: BridgeEvent,
  opts?: { skipPersist?: boolean },
) => {
  if (
    event.type === "CHAT" ||
    event.type === "JOIN" ||
    event.type === "LEAVE" ||
    event.type === "VOICE_JOIN" ||
    event.type === "VOICE_LEAVE"
  ) {
    await persistBridgeEvent(event, opts);
  }

  const locals = localListeners.get(event.bridgeId);
  if (locals) {
    for (const listener of locals) {
      try {
        listener(event);
      } catch (error) {
        logger.error(`Local bridge listener error: ${error}`);
      }
    }
  }

  if (!RabbitMQ.isEnabled()) return;

  const exchange = exchangeFor(event.bridgeId);
  try {
    const channel = await RabbitMQ.ensureChannel();
    await channel.assertExchange(exchange, "fanout", {
      durable: false,
    });
    const ok = channel.publish(
      exchange,
      "",
      Buffer.from(JSON.stringify(event)),
      { type: event.type },
    );
    if (!ok) {
      logger.error(`Failed to publish ${event.type} to ${exchange}`);
    }
  } catch (error) {
    logger.error(`publishBridgeEvent failed: ${error}`);
    RabbitMQ.channel = null;
  }
};

/** Subscribe within this process. Safe with publishBridgeEvent (no double-fire). */
export const subscribeBridge = (bridgeId: string, listener: BridgeListener) => {
  const set = localListeners.get(bridgeId) ?? new Set();
  set.add(listener);
  localListeners.set(bridgeId, set);

  return () => {
    set.delete(listener);
    if (set.size === 0) localListeners.delete(bridgeId);
  };
};

export const isBridgeEventType = (value: string): value is BridgeEventType =>
  [
    "CHAT",
    "JOIN",
    "LEAVE",
    "LINK_RESULT",
    "VOICE_RESULT",
    "VOICE_JOIN",
    "VOICE_LEAVE",
    "PRESENCE",
  ].includes(value);
