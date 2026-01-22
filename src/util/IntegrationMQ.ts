import type { Channel, ConsumeMessage, Options } from "amqplib";
import { RabbitMQ } from "@mutualzz/util/RabbitMQ";
import { JSONReplacer } from "@mutualzz/util/JSON";
import { Logger } from "@mutualzz/logger";

const logger = new Logger({
    tag: "IntegrationMQ",
});

export const INTEGRATION_EXCHANGE = "mz.integration";

export type IntegrationType = "discord-bot" | "minecraft-bridge" | "api";

export interface IntegrationEnvelope<T = unknown> {
    v: 1;
    type: string;
    ts: number;
    id: string;
    source: IntegrationType;
    traceId?: string;
    data: T;
}

export interface PublishIntegrationOpts {
    channel?: Channel;
    persistent?: boolean;
    headers?: Options.Publish["headers"];
}

export const assertIntegrationExchange = async (ch: Channel) => {
    await ch.assertExchange(INTEGRATION_EXCHANGE, "topic", { durable: true });
};

export const publishIntegration = async <T>(
    routingKey: string,
    envelope: IntegrationEnvelope<T>,
    opts?: PublishIntegrationOpts,
) => {
    const ch = opts?.channel ?? RabbitMQ.channel;
    if (!ch) throw new Error("No RabbitMQ channel available");

    await assertIntegrationExchange(ch);

    const body = Buffer.from(JSON.stringify(envelope, JSONReplacer));
    const ok = ch.publish(INTEGRATION_EXCHANGE, routingKey, body, {
        contentType: "application/json",
        type: envelope.type,
        persistent: opts?.persistent ?? true,
        headers: opts?.headers,
    });

    if (!ok) {
        logger.error(
            `Backpressure publishing integration message: ${routingKey} (${envelope.type})`,
        );
        return;
    }

    logger.debug(`Published integration: ${routingKey} (${envelope.type})`);
};

export interface SetupIntegrationConsumerOpts {
    serviceQueue: string;
    bindings: string[];
    prefetch?: number;
    retryDelaysMs?: number[];
    maxAttempts?: number;
    handler: (
        msg: IntegrationEnvelope,
        raw: ConsumeMessage,
        ch: Channel,
    ) => Promise<void>;
}

export const setupIntegrationConsumer = async (
    opts: SetupIntegrationConsumerOpts,
) => {
    if (!RabbitMQ.connection)
        throw new Error("No RabbitMQ connection available");

    const ch = await RabbitMQ.connection.createChannel();
    await assertIntegrationExchange(ch);

    const mainQueue = opts.serviceQueue;
    const dlq = `${mainQueue}.dlq`;

    const retryDelays = opts.retryDelaysMs || [10000, 60000, 300000]; // 10s, 1m, 5m
    const maxAttempts = opts.maxAttempts ?? Math.max(1, retryDelays.length + 2);

    await ch.prefetch(opts.prefetch ?? 25);

    await ch.assertQueue(dlq, { durable: true });

    await ch.assertQueue(mainQueue, {
        durable: true,
        deadLetterExchange: "",
        deadLetterRoutingKey: dlq,
    });

    for (const key of opts.bindings) {
        await ch.bindQueue(mainQueue, INTEGRATION_EXCHANGE, key);
        logger.info(`Bound ${mainQueue} <- ${INTEGRATION_EXCHANGE}:${key}`);
    }

    for (const delay of retryDelays) {
        const rq = `${mainQueue}.retry.${delay}`;
        await ch.assertQueue(rq, {
            durable: true,
            messageTtl: delay,
            deadLetterExchange: "",
            deadLetterRoutingKey: mainQueue,
        });
    }

    const pickRetryQueue = (attempt: number) => {
        const idx = Math.min(attempt - 1, retryDelays.length - 1);
        return `${mainQueue}.retry.${retryDelays[idx]}`;
    };

    await ch.consume(mainQueue, async (raw) => {
        if (!raw) return;

        try {
            const parsed = JSON.parse(
                raw.content.toString(),
            ) as IntegrationEnvelope;

            if (!parsed?.type || !parsed?.ts || !parsed?.id)
                throw new Error("Invalid envelope shape");

            await opts.handler(parsed, raw, ch);
            ch.ack(raw);
        } catch (err) {
            const headers = raw.properties.headers ?? {};
            const attempt = Number(headers["x-attempt"] ?? 0) + 1;

            if (attempt >= maxAttempts) {
                logger.error(
                    `Integration message to DLQ after ${attempt} attempts: ${String(
                        err,
                    )}`,
                );
                ch.reject(raw, false);
                return;
            }

            const retryQ = pickRetryQueue(attempt);

            logger.error(
                `Integration handler error, retrying (attempt ${attempt}/${maxAttempts}) -> ${retryQ}: ${String(
                    err,
                )}`,
            );

            ch.sendToQueue(retryQ, raw.content, {
                contentType: raw.properties.contentType,
                type: raw.properties.type,
                persistent: true,
                headers: {
                    ...headers,
                    "x-attempt": attempt,
                    "x-last-error": String(err),
                },
            });

            ch.ack(raw);
        }
    });

    logger.info(`Integration consumer active: ${mainQueue}`);
    return ch;
};
