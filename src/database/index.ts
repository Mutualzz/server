import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import JSONbig from "json-bigint";
import { Pool, types } from "pg";
import { logger } from "./Logger";
import * as schema from "./schemas";

const JSONBig = JSONbig({ useNativeBigInt: true });

// BIGINT (int8) columns → BigInt
types.setTypeParser(20, (val: string) => BigInt(val));

// JSON (oid 114) → parse with JSONBig
types.setTypeParser(114, (val: string) => JSONBig.parse(val));

// JSONB (oid 3802) → parse with JSONBig
types.setTypeParser(3802, (val: string) => JSONBig.parse(val));

declare global {
    // for dev/hot-reload safety
    var __db__: { pool: Pool; db: NodePgDatabase<typeof schema> } | undefined;
}

export let db: NodePgDatabase<typeof schema>;
export let pool: Pool;

const isDev = process.env.NODE_ENV === "development";

const makePool = () => {
    logger.debug(
        `creating new pool for ${isDev ? "development" : "production"}`,
    );
    return new Pool({
        connectionString: process.env.DATABASE,
        max: 10,
        idleTimeoutMillis: isDev ? 0 : 30_000, // close idle clients after 30s
        connectionTimeoutMillis: 10_000, // fail fast if DB not reachable
        keepAlive: true,
    });
};

export const startDatabase = async () => {
    if (global.__db__) {
        db = global.__db__.db;
        pool = global.__db__.pool;
        logger.warn("already initialized");
        return;
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const p = makePool();

            await p.query("SELECT 1");
            pool = p;
            db = drizzle(pool, {
                logger: process.env.NODE_ENV === "development",
                schema,
            });

            pool.on("error", (err) => {
                // Emitted if a client in the pool emits 'error'
                logger.error(`pool error: ${err.message}`);
            });

            global.__db__ = { pool, db };

            logger.info(`connected (attempt ${attempt})`);
            return;
        } catch (err) {
            lastErr = err;
            const delay = Math.min(2 ** attempt * 200, 5_000);
            logger.warn(
                `connect failed (attempt ${attempt}) — retrying in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    throw new Error(
        `Database connection failed after retries: ${(lastErr as Error)?.message}`,
    );
};

export const closeDatabase = async () => {
    if (!pool) {
        logger.warn("not initialized");
        return;
    }
    await pool.end();
    logger.info("disconnected");
};

let hooksInstalled = false;
export const initDatabaseShutdownHooks = () => {
    if (hooksInstalled) return;
    hooksInstalled = true;

    const shutdown = async (signal: string) => {
        try {
            logger.info(`shutting down on ${signal}`);
            await closeDatabase();
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

export * from "./schemas";
