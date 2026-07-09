import { db, appealsTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { redis, Snowflake } from "@mutualzz/util";
import { validateCreateAppealBody } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";

export default class AppealsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { token, message } = validateCreateAppealBody.parse(
                req.body,
            );

            const redisKey = `accountAppeal:${token}`;
            const userId = await redis.get(redisKey);

            if (!userId)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "This appeal link is invalid or has expired",
                );

            await db.insert(appealsTable).values({
                id: BigInt(Snowflake.generate()),
                userId: BigInt(userId),
                message,
            });

            await redis.del(redisKey);

            res.status(HttpStatusCode.Success).json({ success: true });
        } catch (err) {
            next(err);
        }
    }
}
