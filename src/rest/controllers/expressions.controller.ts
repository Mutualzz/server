import type { NextFunction, Request, Response } from "express";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { imageFileValidator, validateExpressionPutBody, } from "@mutualzz/validators";
import type { expressionsTable } from "@mutualzz/database";
import { requireSpacePermissions, Snowflake } from "@mutualzz/util";

export default class ExpressionsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, type, name } = validateExpressionPutBody.parse(
                req.body,
            );

            const iconFile = imageFileValidator.parse(req.file);

            const expressionValues: typeof expressionsTable.$inferInsert = {
                id: BigInt(Snowflake.generate()),
                type: parseInt(type),
                authorId: BigInt(user.id),
            };

            if (spaceId)
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["CreateExpressions"],
                });
        } catch (err) {
            next(err);
        }
    }
}
