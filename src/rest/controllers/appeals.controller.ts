import { appealsTable, db } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    consumeAppealToken,
    resolveAppealToken,
    Snowflake,
} from "@mutualzz/util";
import { validateCreateAppealBody } from "@mutualzz/validators";
import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class AppealsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { token, message } = validateCreateAppealBody.parse(req.body);

            const resolved = await resolveAppealToken(token);
            if (!resolved)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid or expired appeal link",
                );

            const existing = await db.query.appealsTable.findFirst({
                where:
                    resolved.type === "space_lockdown"
                        ? and(
                              eq(appealsTable.spaceId, BigInt(resolved.spaceId)),
                              eq(appealsTable.status, "pending"),
                          )
                        : and(
                              eq(appealsTable.userId, BigInt(resolved.userId)),
                              isNull(appealsTable.spaceId),
                              eq(appealsTable.status, "pending"),
                          ),
            });

            if (existing?.status === "pending")
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "You already have a pending appeal",
                );

            await db.insert(appealsTable).values({
                id: BigInt(Snowflake.generate()),
                userId: BigInt(resolved.userId),
                spaceId:
                    resolved.type === "space_lockdown"
                        ? BigInt(resolved.spaceId)
                        : null,
                message,
            });

            await consumeAppealToken(token);

            res.status(HttpStatusCode.Success).json({ success: true });
        } catch (err) {
            next(err);
        }
    }
}
