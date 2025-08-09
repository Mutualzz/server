import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";

const {
    SENTRY_DSN_REST,
    SENTRY_DSN_REACT,
    SENTRY_PROJECT_ID_REST,
    SENTRY_PROJECT_ID_REACT,
    SENTRY_HOST,
} = process.env;

export default class SentryController {
    static async sentry(req: Request, res: Response, next: NextFunction) {
        try {
            if (!req.body)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "No body provided",
                );
            const envelope = new TextDecoder().decode(req.body as Buffer);
            const piece = envelope.split("\n")[0];
            const header: Record<string, any> = JSON.parse(piece);
            const dsn = header.dsn as string;

            if (dsn !== SENTRY_DSN_REST && dsn !== SENTRY_DSN_REACT)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Invalid Sentry DSN",
                );

            let upstreamUrl = null;

            if (dsn === SENTRY_DSN_REST) {
                if (!SENTRY_PROJECT_ID_REST)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "SENTRY_PROJECT_ID_REST is not set",
                    );

                upstreamUrl = `https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID_REST}/envelope/`;
            }

            if (dsn === SENTRY_DSN_REACT) {
                if (!SENTRY_PROJECT_ID_REACT)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "SENTRY_PROJECT_ID_REACT is not set",
                    );

                upstreamUrl = `https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID_REACT}/envelope/`;
            }

            if (!upstreamUrl)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Upstream URL failed to resolve",
                );

            const sentryRes = await fetch(upstreamUrl, {
                method: "POST",
                body: req.body,
            });

            if (sentryRes.status !== HttpStatusCode.Success) {
                res.status(sentryRes.status).json({
                    error: "Failed to proxy to Sentry",
                });
                return;
            }

            res.status(sentryRes.status).json({
                message: "Successfully proxied to Sentry",
            });
        } catch (err) {
            next(err);
        }
    }
}
