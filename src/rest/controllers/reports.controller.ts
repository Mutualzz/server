import {
    db,
    messagesTable,
    postCommentsTable,
    postsTable,
    reportsTable,
    spacesTable,
} from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { resolveUserIdentifier, Snowflake } from "@mutualzz/util";
import { validateCreateReportBody } from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class ReportsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { targetType, targetId, reason, description } =
                validateCreateReportBody.parse(req.body);

            let targetExists = false;

            switch (targetType) {
                case "message": {
                    const message = await db.query.messagesTable.findFirst({
                        columns: { id: true },
                        where: eq(messagesTable.id, BigInt(targetId)),
                    });
                    targetExists = !!message;
                    break;
                }
                case "post": {
                    const post = await db.query.postsTable.findFirst({
                        columns: { id: true },
                        where: eq(postsTable.id, BigInt(targetId)),
                    });
                    targetExists = !!post;
                    break;
                }
                case "comment": {
                    const comment =
                        await db.query.postCommentsTable.findFirst({
                            columns: { id: true },
                            where: eq(postCommentsTable.id, BigInt(targetId)),
                        });
                    targetExists = !!comment;
                    break;
                }
                case "user": {
                    const target = await resolveUserIdentifier(targetId);
                    targetExists = !!target;
                    break;
                }
                case "space": {
                    const space = await db.query.spacesTable.findFirst({
                        columns: { id: true },
                        where: eq(spacesTable.id, BigInt(targetId)),
                    });
                    targetExists = !!space;
                    break;
                }
            }

            if (!targetExists)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Reported content not found",
                );

            await db.insert(reportsTable).values({
                id: BigInt(Snowflake.generate()),
                reporterId: BigInt(user.id),
                targetType,
                targetId: BigInt(targetId),
                reason,
                description: description ?? null,
            });

            res.status(HttpStatusCode.Success).json({ success: true });
        } catch (err) {
            next(err);
        }
    }
}
