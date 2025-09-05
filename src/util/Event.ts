import type { APIPrivateUser, APIUser } from "@mutualzz/types";
import type { Channel } from "amqplib";
import { EventEmitter } from "events";
import { logger } from "./Logger";
import { RabbitMQ } from "./RabbitMQ";

export type EVENT = "Ready" | "UserUpdate";

export interface Event {
    user_id?: string;
    event: EVENT;
    data?: any;
}

export interface ReadyEventData {
    v: number;
    user: APIPrivateUser;
    session_id: string;
}

export interface ReadyEvent extends Event {
    event: "Ready";
    data: ReadyEventData;
}

export interface UserUpdateEvent extends Event {
    event: "UserUpdate";
    data: APIPrivateUser & APIUser;
}

export type AllEvents = ReadyEventData | UserUpdateEvent;

export interface EventOpts extends Event {
    acknowledge?: () => unknown;
    channel?: Channel;
    cancel?: (id?: string) => unknown;
}

export interface ListenEventOpts {
    channel?: Channel;
    acknowledge?: boolean;
}

export const events = new EventEmitter();

export const emitEvent = async (payload: Omit<Event, "created_at">) => {
    const id = payload.user_id;
    if (!id) {
        logger.error("No id provided for event emission");
        return;
    }

    if (RabbitMQ.connection) {
        const data =
            typeof payload.data === "object"
                ? JSON.stringify(payload.data)
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
            logger.error(
                `Failed to publish event ${payload.event} for user ${id}`,
            );
        } else {
            logger.debug(`Published event ${payload.event} for user ${id}`);
        }

        return;
    }

    events.emit(payload.event, payload);
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
        if (!channel) {
            logger.error("No channel available for listening to events");
            return;
        }

        return await rabbitListen(channel, event, callback, {
            acknowledge: opts?.acknowledge,
        });
    }

    const cancel = async () => {
        events.removeListener(event, listener);
        events.setMaxListeners(events.getMaxListeners() - 1);
    };
    const listener = (opts: EventOpts) => callback({ ...opts, cancel });

    events.setMaxListeners(events.getMaxListeners() + 1);
    events.addListener(event, listener);

    return cancel;
};
