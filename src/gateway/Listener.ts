import { listenEvent, RabbitMQ, type EventOpts } from "@mutualzz/util";
import type { Channel } from "amqplib";
import { logger } from "./Logger";
import { Send, type WebSocket } from "./util";

export async function setupListener(this: WebSocket) {
    const opts: {
        acknowledge: boolean;
        channel?: Channel & { queues?: unknown; ch?: number };
    } = {
        acknowledge: true,
    };
    this.listenOptions = opts;

    const consumer = consume.bind(this);

    logger.debug(`[RabbitMQ] setupListener: open for ${this.userId}`);

    if (RabbitMQ.connection) {
        logger.debug(
            `[RabbitMQ] setupListener: opts.channel =`,
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
        opts.channel = await RabbitMQ.connection.createChannel();
        opts.channel.queues = {};
        logger.debug(
            "[RabbitMQ] channel created:",
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
    }

    if (this.userId)
        this.events[this.userId] = await listenEvent(
            this.userId,
            consumer,
            opts,
        );

    this.once("close", () => {
        logger.debug(
            `[RabbitMQ] setupListener: close for ${this.userId} =`,
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
        if (opts.channel) opts.channel.close();
        else {
            Object.values(this.events).forEach((x) => x?.());
        }
    });
}

async function consume(this: WebSocket, opts: EventOpts) {
    const { data, event } = opts;

    opts.acknowledge?.();

    await Send(this, {
        op: "Dispatch",
        t: event,
        d: data,
        s: this.sequence++,
    });
}
