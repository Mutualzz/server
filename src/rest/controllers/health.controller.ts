import { pool } from "@mutualzz/database";
import { HttpStatusCode } from "@mutualzz/types";
import type { Request, Response } from "express";
import { redis } from "@mutualzz/util/Redis";
import { logger } from "../Logger";
import { withTimeout } from "@mutualzz/util";

export default class HealthController {
  static async check(_: Request, res: Response) {
    const [databaseCheck, redisCheck] = await Promise.allSettled([
      withTimeout(pool.query("SELECT 1"), 2000),
      withTimeout(redis.ping(), 2000),
    ]);

    const databaseStatus =
      databaseCheck.status === "fulfilled" ? "ok" : "error";
    const redisStatus = redisCheck.status === "fulfilled" ? "ok" : "error";

    if (databaseStatus === "error" || redisStatus === "error") {
      logger.error(
        `Health check failed: database=${databaseStatus}, redis=${redisStatus}`,
        {
          database:
            databaseCheck.status === "rejected" ? databaseCheck.reason : null,
          redis: redisCheck.status === "rejected" ? redisCheck.reason : null,
        },
      );
    }

    const statusCode =
      databaseStatus === "ok" && redisStatus === "ok"
        ? HttpStatusCode.Success
        : HttpStatusCode.ServiceUnavailable;

    res
      .set("Cache-Control", "no-cache, no-store, must-revalidate")
      .status(statusCode)
      .json({
        status: statusCode === HttpStatusCode.Success ? "ok" : "fail",
        uptime: process.uptime(),
        database: databaseStatus,
        redis: redisStatus,
      });
  }
}
