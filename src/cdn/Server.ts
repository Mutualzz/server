import bodyParser from "body-parser";
import cors from "cors";
import express, { Router } from "express";
import fg from "fast-glob";
import { createServer } from "http";
import morgan from "morgan";
import os from "os";
import path from "path";
import sharp from "sharp";
import { pathToFileURL } from "url";
import { DEFAULT_PORT } from "./Constants";
import { logger } from "./Logger";
import errorMiddleware from "./middlewares/error.middleware";

sharp.cache({ files: 0, items: 512, memory: 256 });
sharp.concurrency(Math.max(2, Math.min(8, os.cpus().length - 1)));

export class Server {
    private readonly port: number;
    private readonly app = express();
    private readonly http = createServer(this.app);

    constructor() {
        this.port = isNaN(Number(process.env.CDN_PORT))
            ? DEFAULT_PORT
            : Number(process.env.CDN_PORT);
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
                origin: ["*", "http://localhost:1420"],
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
    }

    private async initMiddlewares() {
        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));
    }

    private async initRoutes() {
        const routesBaseDir = path.join(import.meta.dirname, "cdn", "routes");

        logger.debug(`Loading routes from ${routesBaseDir}`);

        const routeFiles = await fg("**/*.routes.{ts,js,mjs}", {
            cwd: routesBaseDir,
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
            logger.debug(`Route "${routePath}" loaded from "${routeFile}"`);
        }
    }

    private initErrorHandling() {
        this.app.use(errorMiddleware);
    }

    private async init() {
        this.initHeadMiddlewares();
        this.initMiddlewares();
        await this.initRoutes();
        this.initErrorHandling();
    }
}
