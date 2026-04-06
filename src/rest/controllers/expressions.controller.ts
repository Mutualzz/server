import type { NextFunction, Request, Response } from "express";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    imageFileValidator,
    validateExpressionPutBody,
} from "@mutualzz/validators";
import { db, expressionsTable } from "@mutualzz/database";
import { requireSpacePermissions, Snowflake } from "@mutualzz/util";
import sharp from "sharp";

export default class ExpressionsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            let rawCrop;
            if (req.body.crop) rawCrop = JSON.parse(req.body.crop);

            const { spaceId, type, name } = validateExpressionPutBody.parse(
                req.body,
            );

            const iconFile = imageFileValidator.parse(req.file);

            if (spaceId)
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["CreateExpressions"],
                });

            const id = BigInt(Snowflake.generate());
            const expressionName = name ?? id.toString();

            const isGif = iconFile.mimetype === "image/gif";

            let assetSharp: sharp.Sharp;
            if (isGif) assetSharp = sharp(iconFile.buffer, { animated: true });
            else assetSharp = sharp(iconFile.buffer).toFormat("png");

            const expression = await db.insert(expressionsTable).values({
                id,
                type: parseInt(type),
                authorId: BigInt(user.id),
                spaceId: spaceId ? BigInt(spaceId) : null,
                name: expressionName,
            });
        } catch (err) {
            next(err);
        }
    }
}
