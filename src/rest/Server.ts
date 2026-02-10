import "./instrument";

import * as Sentry from "@sentry/node";
import bodyParser from "body-parser";
import cors from "cors";
import express, { Router } from "express";
import fg from "fast-glob";
import helmet from "helmet";
import { createServer } from "http";
import morgan from "morgan";
import multer from "multer";
import path from "path";
import { pathToFileURL } from "url";
import SentryController from "./controllers/sentry.controller";
import { logger } from "./Logger";
import authMiddleware from "./middlewares/auth.middleware";
import errorMiddleware from "./middlewares/error.middleware";
import { DEFAULT_PORT, MAX_FILE_SIZE_BYTES } from "./util";

declare global {
    interface BigInt {
        toJSON(): string;
    }
}

BigInt.prototype.toJSON = function () {
    return String(this);
};

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
    },
});

export class Server {
    private readonly port: number;
    private readonly app = express();
    private readonly http = createServer(this.app);

    constructor() {
        this.port = isNaN(Number(process.env.REST_PORT))
            ? DEFAULT_PORT
            : Number(process.env.REST_PORT);
    }

    async start() {
        await this.init();

        this.http.listen(this.port, () => {
            logger.info(`Server is running on port ${this.port}`);
        });
    }

    async stop() {
        this.http.close(() => {
            logger.info(`Server is stopped`);
        });
    }

    private initHeadMiddlewares() {
        this.app.use(
            cors({
                origin: [
                    "http://localhost:1420",
                    "http://localhost:5173",
                    "https://mutualzz.com",
                    "https://gateway.mutualzz.com",
                    "tauri://localhost",
                    "http://tauri.localhost",
                    "capacitor://localhost",
                    "http://localhost",
                ],
                credentials: true,
            }),
        );

        this.app.use((_, res, next) => {
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("X-Frame-Options", "DENY");
            res.setHeader("X-XSS-Protection", "1; mode=block");
            next();
        });

        this.app.use(
            morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"),
        );

        this.app.disable("x-powered-by");
        this.app.set("trust proxy", true);
    }

    private initSentry() {
        Sentry.setupExpressErrorHandler(this.app);

        this.app.post(
            `/v1/sentry`,
            bodyParser.raw({
                type: () => true,
                limit: "16mb",
            }),
            (...args) => SentryController.sentry(...args),
        );
    }

    private initMiddlewares() {
        this.app.use(helmet());
        this.app.use(authMiddleware);
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
    }

    private async initRoutes() {
        const routesBaseDir =
            process.env.NODE_ENV === "development"
                ? path.join(import.meta.dirname, "routes")
                : path.join(import.meta.dirname, "rest", "routes");

        logger.debug(`Loading routes from ${routesBaseDir}`);

        const routeFiles = await fg("**/*.routes.{ts,js,mjs}", {
            cwd: routesBaseDir,
            onlyFiles: true,
        });

        logger.debug(`Found ${routeFiles.length} route files`);

        for (const routeFile of routeFiles) {
            const fullPath = path.join(routesBaseDir, routeFile);
            const mod = (await import(pathToFileURL(fullPath).href)) as {
                default?: Router;
                middlewares?: any[];
            };

            const route = mod.default;
            if (!route || !(route instanceof Router)) {
                logger.warn(`Invalid or missing router in file: ${routeFile}`);
                continue;
            }

            const rawPath = routeFile.replace(/\.routes\.(ts|js|mjs)$/, "");

            const cleanedPath = rawPath
                .replace(/\/index$/, "") // remove trailing /index
                .split(path.sep)
                .map((segment) => {
                    if (segment.startsWith("[...") && segment.endsWith("]")) {
                        return "*";
                    }
                    if (segment.startsWith("[") && segment.endsWith("]")) {
                        return `:${segment.slice(1, -1)}`;
                    }

                    return segment;
                })
                .join("/");

            const routePath = "/" + cleanedPath;

            const middlewares = mod.middlewares ?? [];

            this.app.use(routePath, ...middlewares, route);
            logger.debug(
                `Route "${routePath}" loaded from "${routeFile}"${middlewares.length > 0 ? ` with middlewares: ${middlewares.map((m) => m.name).join(", ")}` : ""}`,
            );
        }
    }

    private initErrorHandling() {
        this.app.use(errorMiddleware);
    }

    private async init() {
        this.initHeadMiddlewares();
        this.initSentry();
        this.initMiddlewares();
        await this.initRoutes();
        this.initErrorHandling();
    }
}
