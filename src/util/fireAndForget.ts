import { logger as BotLogger } from "@mutualzz/bot/Logger";
import { logger as CDNLogger } from "@mutualzz/cdn/Logger";
import { logger as GatewayLogger } from "@mutualzz/gateway/Logger";
import { logger as RESTLogger } from "@mutualzz/rest/Logger";
import { logger as VoiceLogger } from "../../../voice/src/Logger";
import { Logger } from "@mutualzz/logger";

type MaybePromise<T = unknown> = Promise<T> | T;

type LoggerContext = "bot" | "cdn" | "gateway" | "rest" | "voice" | "other";

interface FireAndForgetOptions {
    label: string;
    meta?: Record<string, unknown>;
    logger?: LoggerContext;
}

function getLogger(context: LoggerContext) {
    switch (context) {
        case "bot":
            return BotLogger;
        case "cdn":
            return CDNLogger;
        case "gateway":
            return GatewayLogger;
        case "rest":
            return RESTLogger;
        case "voice":
            return VoiceLogger;
        case "other":
            return new Logger({ tag: "FireAndForget" });
    }
}

export const fireAndForget = (
    task: () => MaybePromise,
    options?: FireAndForgetOptions,
) => {
    const { label, meta, logger: loggerContext = "rest" } = options || {};

    const logger = getLogger(loggerContext);

    void Promise.resolve()
        .then(task)
        .catch((error) => {
            logger.warn(`[fireAndForget] ${label} failed`, {
                ...meta,
                error:
                    error instanceof Error
                        ? {
                              name: error.name,
                              message: error.message,
                              stack: error.stack,
                          }
                        : String(error),
            });
        });
};

export const fireAndForgetAll = (
    tasks: {
        label: string;
        run: () => MaybePromise;
        meta?: Record<string, unknown>;
    }[],
    options?: Pick<FireAndForgetOptions, "logger">,
) => {
    for (const task of tasks) {
        fireAndForget(task.run, {
            label: task.label,
            meta: task.meta,
            logger: options?.logger ?? "other",
        });
    }
};
