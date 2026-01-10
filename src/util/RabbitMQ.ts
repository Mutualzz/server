import { Logger } from "@mutualzz/logger";
import type { BaseEvent, EVENT } from "@mutualzz/types";
import amqplib, { type Channel, type ChannelModel } from "amqplib";
import EventEmitter from "events";
import { JSONReplacer } from "./JSON";

const logger = new Logger({
    tag: "RabbitMQ",
});

export class RabbitMQ {
    static connection: ChannelModel;
    static channel: Channel;

    static async init() {
        this.connection = await amqplib.connect(
            `amqp://${process.env.RABBIT_USERNAME}:${process.env.RABBIT_PASSWORD}@${process.env.RABBIT_HOSTNAME}:${process.env.RABBIT_PORT}/%2f`,
            {
                timeout: 10000,
            },
        );
        logger.info("Connected to RabbitMQ");
        this.channel = await this.connection.createChannel();
        logger.info("Channel created");
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

    if (RabbitMQ.connection) {
        const data =
            typeof payload.data === "object"
                ? JSON.stringify(payload.data, JSONReplacer)
                : payload.data;

        await RabbitMQ.channel.assertExchange(id, "fanout", {
            durable: false,
        });

        const success = RabbitMQ.channel.publish(
            id,
            "",
            Buffer.from(`${data}`),
            { type: payload.event },
        );

        if (!success) {
            logger.error(`Failed to publish event ${payload.event} to ${id}`);
        } else {
            logger.debug(`Published event ${payload.event} to ${id}`);
        }

        return;
    }

    events.emit(id, payload);
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
        await channel.cancel(q.queue);
        await channel.unbindQueue(q.queue, id, "");
    };

    await channel.bindQueue(q.queue, id, "");
    await channel.consume(
        q.queue,
        (opts) => {
            if (!opts) return;

            const data = JSON.parse(opts.content.toString());
            const event = opts.properties.type as EVENT;

            callback({
                event,
                data,
                acknowledge() {
                    channel.ack(opts);
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
