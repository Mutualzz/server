import { Listener } from "@sapphire/framework";
import { container } from "@sapphire/pieces";
import type { RateLimitError } from "discord.js";
import ms from "ms";

export default class RateLimitEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "rateLimited",
            name: "rest-rate-limit",
            description: "Emits when the bot is rate limited",
            emitter: container.client.rest,
        });
    }

    run(error: RateLimitError) {
        const { logger } = container;

        logger.error(
            `[REST Rate Limit] ${error.route} | ${error.method} ${error.url}`,
        );
        logger.error(
            `[REST Rate Limit] Try again in ${ms(error.retryAfter, { long: true })}`,
        );
    }
}
