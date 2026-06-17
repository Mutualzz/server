import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import path from "path";
import sharp from "sharp";
import { MIME_TYPES } from "../Constants";
import { contentEtag, normalizeFormat } from "../utils";

export default class ProfilesController {
    static async getBanner(req: Request, res: Response, next: NextFunction) {
        return ProfilesController.getAsset(req, res, next, "banner");
    }

    static async getBackground(req: Request, res: Response, next: NextFunction) {
        return ProfilesController.getAsset(req, res, next, "background");
    }

    static async getMusic(req: Request, res: Response, next: NextFunction) {
        try {
            const { userId, asset } = req.params as {
                userId: string;
                asset: string;
            };

            const baseName = path.basename(asset, path.extname(asset));
            const sourceKey = `profiles/${userId}/music/${baseName}.mp3`;

            let sourceBody: Uint8Array;
            try {
                const { Body } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: sourceKey,
                    }),
                );
                if (!Body) throw new Error("Empty body");
                sourceBody = await Body.transformToByteArray();
            } catch {
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Profile music not found",
                );
            }

            const etag = contentEtag(sourceBody);
            if (req.headers["if-none-match"] === etag) {
                res.status(304).end();
                return;
            }

            res.setHeader("Cache-Control", "public, max-age=86400, immutable");
            res.setHeader("ETag", etag);
            res.setHeader("Content-Type", "audio/mpeg");
            res.send(Buffer.from(sourceBody));
        } catch (err) {
            next(err);
        }
    }

    private static async getAsset(
        req: Request,
        res: Response,
        next: NextFunction,
        assetType: "banner" | "background",
    ) {
        try {
            const { userId, asset } = req.params as {
                userId: string;
                asset: string;
            };

            const {
                format: formatQuery,
                size: sizeQuery,
                animated: animatedQueryRaw,
            } = req.query as {
                format?: string;
                size?: string;
                animated?: string;
            };

            const baseName = path.basename(asset, path.extname(asset));
            const urlExt = path.extname(asset).replace(".", "").toLowerCase();
            const isAnimatedHash = baseName.startsWith("a_");

            let targetFormat =
                normalizeFormat(formatQuery) ?? normalizeFormat(urlExt);

            const animatedQuery = String(animatedQueryRaw ?? "").toLowerCase();
            const explicitAnimated = ["true", "1", "on", "yes"].includes(
                animatedQuery,
            );

            if (!targetFormat) {
                targetFormat =
                    isAnimatedHash && explicitAnimated ? "webp" : "png";
            }

            const willAnimate =
                isAnimatedHash &&
                (targetFormat === "gif" ||
                    (targetFormat === "webp" && explicitAnimated));

            const boundedSize = sizeQuery ? Number(sizeQuery) : undefined;
            const sourceExt = isAnimatedHash ? "gif" : "png";
            const sourceKey = `profiles/${userId}/${assetType}/${baseName}.${sourceExt}`;

            let sourceBody: Uint8Array;
            try {
                const { Body } = await s3Client.send(
                    new GetObjectCommand({
                        Bucket: bucketName,
                        Key: sourceKey,
                    }),
                );
                if (!Body) throw new Error("Empty body");
                sourceBody = await Body.transformToByteArray();
            } catch {
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Profile asset not found",
                );
            }

            let image: sharp.Sharp = willAnimate
                ? sharp(sourceBody, { animated: true })
                : sharp(sourceBody);

            if (typeof image.toColourspace === "function") {
                image = image.toColourspace("srgb");
            }

            if (boundedSize && !isNaN(boundedSize)) {
                image = image.resize(boundedSize, boundedSize, {
                    fit: "cover",
                });
            }

            const outputBuffer = await image
                .toFormat(targetFormat as keyof sharp.FormatEnum)
                .toBuffer();

            const etag = contentEtag(outputBuffer);
            if (req.headers["if-none-match"] === etag) {
                res.status(304).end();
                return;
            }

            res.setHeader("Cache-Control", "public, max-age=86400, immutable");
            res.setHeader("ETag", etag);
            res.setHeader(
                "Content-Type",
                MIME_TYPES[targetFormat] ?? "application/octet-stream",
            );
            res.send(outputBuffer);
        } catch (err) {
            next(err);
        }
    }
}
