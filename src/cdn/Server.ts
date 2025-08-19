import { logger } from "@mutualzz/util";
import bodyParser from "body-parser";
import express, { Router } from "express";
import fg from "fast-glob";
import { createServer } from "http";
import morgan from "morgan";
import path from "path";
import { pathToFileURL } from "url";
import errorMiddleware from "./middlewares/error.middleware";
import { DEFAULT_PORT } from "./utils/Constants";

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
            logger.info(`[CDN] Server is running on port ${this.port}`);
        });
    }

    async stop() {
        this.http.close(() => {
            logger.info(`[CDN] Server is stopped`);
        });
    }

    private initHeadMiddlewares() {
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

        logger.debug(`[CDN] Loading routes from ${routesBaseDir}`);

        const routeFiles = await fg("**/*.routes.{ts,js,mjs}", {
            cwd: routesBaseDir,
        });

        logger.debug(`[CDN] Found ${routeFiles.length} route files`);

        for (const routeFile of routeFiles) {
            const fullPath = path.join(routesBaseDir, routeFile);
            const mod = (await import(pathToFileURL(fullPath).href)) as {
                default?: Router;
                middlewares?: any[];
            };

            const route = mod.default;
            if (!route || !(route instanceof Router)) {
                logger.warning(
                    `[CDN] Invalid or missing router in file: ${routeFile}`,
                );
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
                `[CDN] Route "${routePath}" loaded from "${routeFile}"`,
            );
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
