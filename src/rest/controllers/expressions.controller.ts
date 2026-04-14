import type { NextFunction, Request, Response } from "express";
import type { APIExpression } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { imageFileValidator, validateExpressionParams, validateExpressionPutBody, } from "@mutualzz/validators";
import { db, expressionsTable } from "@mutualzz/database";
import { bucketName, emitEvent, execNormalized, requireSpacePermissions, s3Client, Snowflake, } from "@mutualzz/util";
import { generateHash } from "@mutualzz/rest/util";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { count, eq } from "drizzle-orm";

export default class ExpressionsController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            let parsedCrop;
            if (req.body.crop) parsedCrop = JSON.parse(req.body.crop);

            const { spaceId, type, name, crop } =
                validateExpressionPutBody.parse({
                    ...req.body,
                    crop: parsedCrop,
                });
            const expressionFile = imageFileValidator.parse(req.file);

            if (spaceId) {
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["CreateExpressions"],
                });

                const { counted } = await db
                    .select({
                        counted: count(),
                    })
                    .from(expressionsTable)
                    .where(eq(expressionsTable.spaceId, BigInt(spaceId)))
                    .then((r) => r[0]);

                if (counted === 100)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "Space has reached its maximum number of expressions",
                    );
            } else {
                const { counted } = await db
                    .select({ counted: count() })
                    .from(expressionsTable)
                    .where(eq(expressionsTable.authorId, BigInt(user.id)))
                    .then((r) => r[0]);

                if (counted === 100)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You have reached maximum number of expressions",
                    );
            }

            const id = BigInt(Snowflake.generate());

            const isGif = expressionFile.mimetype === "image/gif";
            let buffer: Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike> =
                expressionFile.buffer;

            let expressionSharp: sharp.Sharp;
            if (isGif) {
                expressionSharp = sharp(expressionFile.buffer, {
                    animated: true,
                });

                if (crop) {
                    const { x, y, width, height } = crop;
                    expressionSharp = expressionSharp.extract({
                        left: x,
                        top: y,
                        width,
                        height,
                    });

                    buffer = await expressionSharp.toBuffer();
                }
            }

            const assetHash = generateHash(buffer, isGif);
            let existingImage = null;
            const storedExt = isGif ? "gif" : "png";

            try {
                const { Body } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: `expressions/${id}/${assetHash}.${storedExt}`,
                    }),
                );

                existingImage = Body;
            } catch {
                // Ignore
            }

            if (!existingImage)
                await s3Client.send(
                    new PutObjectCommand({
                        Bucket: bucketName,
                        Body: buffer,
                        Key: `expressions/${id}/${assetHash}.${storedExt}`,
                        ContentType: isGif ? "image/gif" : "image/png",
                    }),
                );

            const newExpression = await execNormalized<APIExpression>(
                db
                    .insert(expressionsTable)
                    .values({
                        id,
                        type: parseInt(type),
                        authorId: BigInt(user.id),
                        spaceId: spaceId ? BigInt(spaceId) : null,
                        name: name ?? id.toString(),
                        assetHash,
                    })
                    .returning()
                    .then((r) => r[0]),
            );

            if (!newExpression)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Failed to create expression",
                );

            if (spaceId)
                await emitEvent({
                    space_id: spaceId,
                    data: newExpression,
                    event: "ExpressionCreate",
                });
            else
                await emitEvent({
                    user_id: user.id,
                    data: newExpression,
                    event: "ExpressionCreate",
                });

            return res.status(HttpStatusCode.Created).send(newExpression);
        } catch (err) {
            next(err);
        }
    }

    static async get(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { expressionId } = validateExpressionParams.parse(req.params);

            const expression = await execNormalized<APIExpression>(
                db.query.expressionsTable.findFirst({
                    where: eq(expressionsTable.id, BigInt(expressionId)),
                }),
            );

            if (!expression)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Expression not found",
                );

            return res.status(HttpStatusCode.Success).json(expression);
        } catch (err) {
            next(err);
        }
    }

    static async patch(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { expressionId } = validateExpressionParams.parse(req.params);
            const { name } = validateExpressionPutBody
                .partial()
                .parse(req.body);

            const expression = await execNormalized<APIExpression>(
                db.query.expressionsTable.findFirst({
                    where: eq(expressionsTable.id, BigInt(expressionId)),
                }),
            );

            if (!expression)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Expression not found",
                );

            if (expression.spaceId)
                await requireSpacePermissions({
                    spaceId: expression.spaceId,
                    userId: user.id,
                    needed: ["ManageExpressions"],
                });
            else if (BigInt(expression.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot edit this expression",
                );

            const updatedExpression = await execNormalized<APIExpression>(
                db
                    .update(expressionsTable)
                    .set({ name })
                    .where(eq(expressionsTable.id, BigInt(expressionId)))
                    .returning()
                    .then((r) => r[0]),
            );

            if (!updatedExpression)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Failed to update expression",
                );

            if (expression.spaceId)
                await emitEvent({
                    space_id: expression.spaceId,
                    data: updatedExpression,
                    event: "ExpressionUpdate",
                });
            else
                await emitEvent({
                    user_id: user.id,
                    data: updatedExpression,
                    event: "ExpressionUpdate",
                });

            return res.status(HttpStatusCode.Success).json(updatedExpression);
        } catch (err) {
            next(err);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;

            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { expressionId } = validateExpressionParams.parse(req.params);

            const expression = await execNormalized<APIExpression>(
                db.query.expressionsTable.findFirst({
                    where: eq(expressionsTable.id, BigInt(expressionId)),
                }),
            );

            if (!expression)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Expression not found",
                );

            if (expression.spaceId)
                await requireSpacePermissions({
                    spaceId: expression.spaceId,
                    userId: user.id,
                    needed: ["ManageExpressions"],
                });
            else if (BigInt(expression.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You cannot delete this expression",
                );

            await db
                .delete(expressionsTable)
                .where(eq(expressionsTable.id, BigInt(expressionId)));

            const ext = expression.assetHash.startsWith("a_") ? "gif" : "png";
            try {
                await s3Client.send(
                    new DeleteObjectCommand({
                        Bucket: bucketName,
                        Key: `expressions/${expression.id}/${expression.assetHash}.${ext}`,
                    }),
                );
            } catch {
                // Ignore cuz it might be deleted
            }

            if (expression.spaceId)
                await emitEvent({
                    space_id: expression.spaceId,
                    data: expression,
                    event: "ExpressionDelete",
                });
            else
                await emitEvent({
                    user_id: user.id,
                    data: expression,
                    event: "ExpressionDelete",
                });

            return res.status(HttpStatusCode.Success).json(expression);
        } catch (err) {
            next(err);
        }
    }
}
