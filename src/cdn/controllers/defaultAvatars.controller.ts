import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import path from "path";
import sharp, { type FormatEnum } from "sharp";
import { MIME_TYPES } from "../utils/Constants";

const defaultAvatarCache = new LRUCache<string, Uint8Array>({
    max: 300,
    ttl: 1000 * 60 * 60 * 24, // 1 day
});

export default class DefaultAvatarsController {
    static async getDefaultAvatar(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const { id } = req.params;
            const { format: formatQuery, size } = req.query;

            const ext = path.extname(id).replace(".", "").toLowerCase();
            const finalFormat = (formatQuery as string) || ext;
            const name = id.replace(/\.[^/.]+$/, "");

            let cacheKey = `${name}:${finalFormat}`;
            if (size) cacheKey += `:${size}`;

            let outputBuffer = defaultAvatarCache.get(cacheKey);

            if (!outputBuffer) {
                // Fetch original from S3
                const { Body } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: `defaultAvatars/${id}`,
                    }),
                );

                if (!Body) {
                    throw new HttpException(
                        HttpStatusCode.NotFound,
                        "Default Avatar not found",
                    );
                }

                const originalBuffer = await Body.transformToByteArray();

                if (!size && !formatQuery) {
                    outputBuffer = originalBuffer;
                } else {
                    let image = sharp(originalBuffer);

                    if (formatQuery) {
                        image = image.toFormat(formatQuery as keyof FormatEnum);
                    }

                    if (size && !isNaN(Number(size))) {
                        const numericSize = Number(size);
                        image = image.resize({
                            width: numericSize,
                            height: numericSize,
                        });
                    }

                    // Single transformation → Buffer
                    outputBuffer = await image.toBuffer();

                    // Cache the transformed result
                    defaultAvatarCache.set(cacheKey, outputBuffer);
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
