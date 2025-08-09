import * as Sentry from "@sentry/node";

// Ensure to call this before importing any other modules!
Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,
    tracesSampleRate: 1.0,
});

export { Sentry };
