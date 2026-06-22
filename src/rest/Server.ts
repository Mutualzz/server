import "./instrument";

import * as Sentry from "@sentry/node";
import bodyParser from "body-parser";
import cors from "cors";
import express, { Router } from "express";
import fg from "fast-glob";
import helmet from "helmet";
import { createServer } from "http";
import multer from "multer";
import path from "path";
import { pathToFileURL } from "url";
import SentryController from "./controllers/sentry.controller";
import { logger } from "./Logger";
import authMiddleware from "./middlewares/auth.middleware";
import errorMiddleware from "./middlewares/error.middleware";
import { DEFAULT_PORT, MAX_FILE_SIZE_BYTES } from "./util";
import type { LogLevel } from "@mutualzz/logger";
import {
  checkArachnid,
  reportToNCMEC,
  validateAttachment,
} from "@mutualzz/util/contentSafety";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";

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
  fileFilter: (_req, file, cb) => {
    const { ok, reason } = validateAttachment(file.mimetype, file.size);
    if (!ok)
      return cb(
        new HttpException(HttpStatusCode.BadRequest, reason ?? "Invalid file"),
      );

    cb(null, true);
  },
});

export const scanUploads = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const files: Express.Multer.File[] = req.file
      ? [req.file]
      : Array.isArray(req.files)
        ? req.files
        : Object.values(req.files ?? {}).flat();

    if (files.length === 0) return next();

    const user = req.user;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!user)
      return next(
        new HttpException(HttpStatusCode.Unauthorized, "Unauthorized"),
      );

    const uploadedAt = new Date().toISOString();

    for (const file of files) {
      const isMedia =
        file.mimetype.startsWith("image/") ||
        file.mimetype.startsWith("video/") ||
        file.mimetype.startsWith("audio/");

      if (!isMedia) continue;

      const arachnidMatch = await checkArachnid(file.buffer, file.mimetype);

      if (arachnidMatch) {
        reportToNCMEC({
          userId: user.id,
          username: user.username,
          email: user.email,
          ipAddress: req.ip ?? "unknown",
          uploadedAt,
          buffer: file.buffer,
          filename: file.originalname,
        }).catch((err) => logger.error(`[NCMEC] Report failed`, err));

        return next(
          new HttpException(
            HttpStatusCode.BadRequest,
            "Upload rejected by content policy",
          ),
        );
      }
    }

    next();
  } catch (err) {
    next(err);
  }
};

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

  private initLoggerMiddleware() {
    this.app.use((req, res, next) => {
      const start = process.hrtime.bigint();

      res.on("finish", () => {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1e6;

        const status = res.statusCode;

        const ip =
          (req.headers["x-forwarded-for"] as string | undefined)?.split(
            ",",
          )[0] ||
          req.socket.remoteAddress ||
          "-";

        const contentLength = res.getHeader("content-length") || 0;

        const baseMessage = `${req.method} ${req.originalUrl} ${status} ${durationMs.toFixed(2)} ms`;

        let level: LogLevel = "info";
        if (status >= 500) level = "error";
        else if (status >= 400) level = "warn";

        const isSlow = durationMs > 1000;

        logger[level]({
          msg: baseMessage,
          method: req.method,
          url: req.originalUrl,
          status,
          duration: `${durationMs}ms`,
          ip,
          userAgent: req.headers["user-agent"],
          contentLength: Number(contentLength),
          slow: isSlow ? "Yes" : "No",
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          user: req.user ? `${req.user.id} (${req.user.username})` : "no user",
        });
      });

      next();
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
    this.app.set("etag", false);

    this.app.disable("x-powered-by");
    this.app.set("trust proxy", true);
  }

  private initSentry() {
    Sentry.setupExpressErrorHandler(this.app);

    this.app.post(
      `/sentry`,
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
    const routesBaseDir = path.join(import.meta.dirname, "routes");

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
    this.initLoggerMiddleware();
    await this.initRoutes();
    this.initErrorHandling();
  }
}
