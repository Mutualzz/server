import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import path from "path";
import sharp, { type FormatEnum } from "sharp";
import { MIME_TYPES } from "../utils/Constants";

const avatarCache = new LRUCache<string, Uint8Array>({
    max: 300,
    ttl: 1000 * 60 * 60 * 24, // 1 day
});

export default class AvatarsController {
    static async getAvatar(req: Request, res: Response, next: NextFunction) {
        try {
            const { userId, avatar } = req.params;
            const { format: formatQuery, size } = req.query;

            const ext = path.extname(avatar).replace(".", "").toLowerCase();
            const finalFormat = (formatQuery as string) || ext;
            const hash = avatar.replace(/\.[^/.]+$/, "");

            let cacheKey = `${userId}:${hash}:${finalFormat}`;
            if (size) cacheKey += `:${size}`;

            let outputBuffer = avatarCache.get(cacheKey);

            if (!outputBuffer) {
                // Fetch original from S3
                const { Body } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: `avatars/${userId}/${hash}.${ext}`,
                    }),
                );

                if (!Body) {
                    throw new HttpException(
                        HttpStatusCode.NotFound,
                        "Avatar not found",
                    );
                }

                const originalBuffer = await Body.transformToByteArray();

                if (!size && !formatQuery) {
                    outputBuffer = originalBuffer;
                } else {
                    const isGif = ext === "gif";
                    const isStaticFormat =
                        formatQuery &&
                        ["png", "jpeg", "jpg", "webp"].includes(
                            (formatQuery as string).toLowerCase(),
                        );

                    let image: sharp.Sharp;
                    if (isGif && !isStaticFormat) {
                        image = sharp(originalBuffer, { animated: true });
                        if (size && !isNaN(Number(size))) {
                            const numericSize = Number(size);
                            image = image.resize({
                                width: numericSize,
                                height: numericSize,
                            });
                        }
                        if (formatQuery) {
                            image = image.toFormat(
                                formatQuery as keyof FormatEnum,
                            );
                        }
                        outputBuffer = await image.toBuffer();
                    } else {
                        image = sharp(originalBuffer);
                        if (size && !isNaN(Number(size))) {
                            const numericSize = Number(size);
                            image = image.resize({
                                width: numericSize,
                                height: numericSize,
                            });
                        }
                        if (formatQuery) {
                            image = image.toFormat(
                                formatQuery as keyof FormatEnum,
                            );
                        }
                        outputBuffer = await image.toBuffer();
                    }

                    // Cache the transformed result
                    avatarCache.set(cacheKey, outputBuffer);
                }
            }

            // Compute ETag from transformed buffer
            const etag = crypto
                .createHash("md5")
                .update(outputBuffer)
                .digest("hex");

            if (req.headers["if-none-match"] === etag) {
                res.status(304).end();
                return;
            }

            // Set headers
            res.setHeader("Cache-Control", "public, max-age=86400, immutable");
            res.setHeader("ETag", etag);
            res.setHeader(
                "Content-Type",
                MIME_TYPES[finalFormat] || "application/octet-stream",
            );

            // Send once
            res.status(HttpStatusCode.Success).end(outputBuffer);
        } catch (err) {
            next(err);
        }
    }
}
