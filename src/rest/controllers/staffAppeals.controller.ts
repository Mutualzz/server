import { appealsTable, db } from "@mutualzz/database";
import type { APIAppeal } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { execNormalizedMany, requireStaff } from "@mutualzz/util";
import {
    validateStaffAppealParams,
    validateStaffAppealUpdateBody,
    validateStaffAppealsQuery,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const appealUserColumns = {
    id: true,
    username: true,
    globalName: true,
    avatar: true,
} as const;

export default class StaffAppealsController {
    static async list(req: Request, res: Response, next: NextFunction) {
        try {
            requireStaff(req.user);

            const { status, before, limit } = validateStaffAppealsQuery.parse(
                req.query,
            );

            const conditions = [];
            if (status) conditions.push(eq(appealsTable.status, status));
            if (before) conditions.push(lt(appealsTable.id, BigInt(before)));

            const appeals = await execNormalizedMany<APIAppeal>(
                db.query.appealsTable.findMany({
                    where: conditions.length ? and(...conditions) : undefined,
                    orderBy: desc(appealsTable.createdAt),
                    limit,
                    with: {
                        user: { columns: appealUserColumns },
                        reviewedBy: { columns: appealUserColumns },
                    },
                }),
            );

            res.status(HttpStatusCode.Success).json(appeals);
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);
            const { appealId } = validateStaffAppealParams.parse(req.params);
            const { status, staffResponse } =
                validateStaffAppealUpdateBody.parse(req.body);

            const updated = await db
                .update(appealsTable)
                .set({
                    status,
                    staffResponse: staffResponse ?? null,
                    reviewedById: BigInt(actor.id),
                    reviewedAt: new Date(),
                })
                .where(eq(appealsTable.id, BigInt(appealId)))
                .returning({ id: appealsTable.id });

            if (!updated.length) {
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Appeal not found",
                );
            }

            const appeals = await execNormalizedMany<APIAppeal>(
                db.query.appealsTable.findMany({
                    where: eq(appealsTable.id, BigInt(appealId)),
                    with: {
                        user: { columns: appealUserColumns },
                        reviewedBy: { columns: appealUserColumns },
                    },
                }),
            );

            res.status(HttpStatusCode.Success).json(appeals[0]);
        } catch (err) {
            next(err);
        }
    }
}
