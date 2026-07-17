/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Logger } from "@mutualzz/logger";
import type { BaseEvent, EVENT } from "@mutualzz/types";
import amqplib, { type Channel, type ChannelModel } from "amqplib";
import EventEmitter from "events";
import { JSONReplacer } from "./JSON";

const logger = new Logger({
  tag: "RabbitMQ",
});

const URI = `amqp://${process.env.RABBIT_USERNAME}:${process.env.RABBIT_PASSWORD}@${process.env.RABBIT_HOSTNAME}:${process.env.RABBIT_PORT}/%2f`;
const RECONNECT_DELAY_MS = 3000;

export class RabbitMQ {
  static connection: ChannelModel | null = null;
  static channel: Channel | null = null;

  private static connecting: Promise<void> | null = null;
  private static reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static shuttingDown = false;
  private static enabled = false;

  static attachChannelHandlers(channel: Channel, label: string) {
    channel.on("error", (error) => {
      logger.error(`RabbitMQ channel error (${label})`, error);
    });

    channel.on("close", () => {
      logger.warn(`RabbitMQ channel closed (${label})`);
      if (label === "publish" && this.channel === channel) {
        this.channel = null;
        if (this.connection && !this.shuttingDown) {
          void this.ensureChannel().catch((error) => {
            logger.error(`Failed to recreate publish channel: ${error}`);
          });
        }
      }
    });
  }

  static async init() {
    this.shuttingDown = false;
    await this.connect();
  }

  static async close() {
    this.shuttingDown = true;
    this.enabled = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;

    try {
      await channel?.close();
    } catch {
    }

    try {
      await connection?.close();
    } catch {
    }
  }

  static async ensureChannel(): Promise<Channel> {
    if (this.channel) return this.channel;
    await this.connect();
    if (!this.channel) {
      throw new Error("RabbitMQ channel unavailable");
    }
    return this.channel;
  }

  static isEnabled() {
    return this.enabled && !this.shuttingDown;
  }

  private static scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer || this.connecting) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        logger.error(`RabbitMQ reconnect failed: ${error}`);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private static async connect() {
    if (this.shuttingDown) return;
    if (this.channel) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        if (!this.connection) {
          this.connection = await amqplib.connect(URI, {
            timeout: 10000,
          });
          logger.info("Connected to RabbitMQ");

          this.connection.on("error", (error) => {
            logger.error("RabbitMQ connection error", error);
          });

          this.connection.on("close", () => {
            logger.warn("RabbitMQ connection closed");
            this.connection = null;
            this.channel = null;
            this.scheduleReconnect();
          });
        }

        this.channel = await this.connection.createChannel();
        this.attachChannelHandlers(this.channel, "publish");
        this.enabled = true;
        logger.info("Channel created");
      } catch (error) {
        this.connection = null;
        this.channel = null;
        logger.error(`Failed to connect to RabbitMQ: ${error}`);
        this.scheduleReconnect();
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }
}

export interface EventOpts extends BaseEvent {
  acknowledge?: () => unknown;
  channel?: Channel;
  cancel?: (id?: string) => unknown;
}

export interface ListenEventOpts {
  channel?: Channel;
  acknowledge?: boolean;
}

export const events = new EventEmitter();

export const emitEvent = async (payload: BaseEvent) => {
  const id = (
    payload.space_id ||
    payload.channel_id ||
    payload.user_id
  )?.toString();
  if (!id) {
    logger.error("No id provided for event emission");
    return;
  }

  if (!RabbitMQ.isEnabled()) {
    events.emit(id, payload);
    return;
  }

  try {
    const channel = await RabbitMQ.ensureChannel();
    const data =
      typeof payload.data === "object"
        ? JSON.stringify(payload.data, JSONReplacer)
        : payload.data;

    await channel.assertExchange(id, "fanout", {
      durable: false,
    });

    const success = channel.publish(id, "", Buffer.from(`${data}`), {
      type: payload.event,
    });

    if (!success) {
      logger.error(`Failed to publish event ${payload.event} to ${id}`);
    } else {
      logger.debug(`Published event ${payload.event} to ${id}`);
    }
  } catch (error) {
    logger.error(`Failed to emit event ${payload.event} to ${id}: ${error}`);
    RabbitMQ.channel = null;
  }
};

const rabbitListen = async (
  channel: Channel,
  id: string,
  callback: (event: EventOpts) => unknown,
  opts?: { acknowledge?: boolean },
) => {
  await channel.assertExchange(id, "fanout", { durable: false });
  const q = await channel.assertQueue("", {
    exclusive: true,
    autoDelete: true,
  });

  const cancel = async () => {
    try {
      await channel.cancel(q.queue);
      await channel.unbindQueue(q.queue, id, "");
    } catch (error) {
      logger.warn(`Failed to cancel listener on ${id}: ${error}`);
    }
  };

  await channel.bindQueue(q.queue, id, "");
  await channel.consume(
    q.queue,
    (message) => {
      if (!message) return;

      const data = JSON.parse(message.content.toString());
      const event = message.properties.type as EVENT;
      let acknowledged = false;

      callback({
        event,
        data,
        acknowledge() {
          if (acknowledged) return;
          acknowledged = true;

          try {
            channel.ack(message);
          } catch (error) {
            logger.warn(`Failed to ack ${event} on ${id}: ${error}`);
          }
        },
        channel,
        cancel,
      });
    },
    {
      noAck: !opts?.acknowledge,
    },
  );

  return cancel;
};

export const listenEvent = async (
  event: string,
  callback: (event: EventOpts) => unknown,
  opts?: ListenEventOpts,
) => {
  if (RabbitMQ.connection) {
    const channel = opts?.channel ?? RabbitMQ.channel;
    if (!channel)
      throw new Error("No channel available for listening to events");

    return await rabbitListen(channel, event, callback, {
      acknowledge: opts?.acknowledge,
    });
  }

  const listener = (opts: EventOpts) => callback({ ...opts, cancel });
  const cancel = async () => {
    events.removeListener(event, listener);
    events.setMaxListeners(events.getMaxListeners() - 1);
  };
  events.setMaxListeners(events.getMaxListeners() + 1);
  events.addListener(event, listener);

  return cancel;
};
