import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import path from "path";

const FONT_HASH_RE = /^[a-f0-9]{64}$/i;
const MUSIC_HASH_RE = /^[a-f0-9]{64}$/i;

async function streamObject(
    key: string,
    res: Response,
    contentType: string,
    cacheControl = "public, max-age=31536000, immutable",
) {
    const { Body, ContentLength } = await s3Client.send(
        new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
        }),
    );

    if (!Body) {
        throw new HttpException(HttpStatusCode.NotFound, "Asset not found");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
    if (ContentLength) {
        res.setHeader("Content-Length", ContentLength.toString());
    }

    const buffer = await Body.transformToByteArray();
    res.status(HttpStatusCode.Success).send(Buffer.from(buffer));
}

export default class ProfilesController {
    static async getFont(req: Request, res: Response, next: NextFunction) {
        try {
            const { userId, font } = req.params as {
                userId: string;
                font: string;
            };

            const hash = path.basename(font, path.extname(font));
            if (!FONT_HASH_RE.test(hash)) {
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid font hash",
                );
            }

            await streamObject(
                `profiles/${userId}/fonts/${hash}.woff2`,
                res,
                "font/woff2",
            );
        } catch (err) {
            next(err);
        }
    }

    static async getMusic(req: Request, res: Response, next: NextFunction) {
        try {
            const { userId, music } = req.params as {
                userId: string;
                music: string;
            };

            const hash = path.basename(music, path.extname(music));
            if (!MUSIC_HASH_RE.test(hash)) {
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Invalid music hash",
                );
            }

            await streamObject(
                `profiles/${userId}/music/${hash}.mp3`,
                res,
                "audio/mpeg",
            );
        } catch (err) {
            next(err);
        }
    }
}
