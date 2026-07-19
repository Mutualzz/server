import { GetObjectCommand } from "@aws-sdk/client-s3";
import { appIconCache, getCache } from "@mutualzz/cache";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { readFile } from "fs/promises";
import path from "path";
import sharp, { type FormatEnum } from "sharp";
import { MIME_TYPES } from "../Constants";

const LOCAL_ASSETS_DIR = path.join(
  import.meta.dirname,
  "../../../assets/app-icons",
);

async function readLocalIcon(id: string) {
  try {
    return await readFile(path.join(LOCAL_ASSETS_DIR, `${id}.png`));
  } catch {
    return null;
  }
}

async function readS3Icon(id: string) {
  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `app-icons/${id}.png`,
      }),
    );
    if (!Body) return null;
    return Buffer.from(await Body.transformToByteArray());
  } catch {
    return null;
  }
}

export default class AppIconsController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const rawId = req.params.id as string;
      const id = rawId.replace(/\.png$/i, "");

      if (!id.match(/^[a-z0-9_-]+$/i)) {
        throw new HttpException(HttpStatusCode.BadRequest, "Invalid app icon ID");
      }

      const { format: formatQuery, size } = req.query;
      const finalFormat = (formatQuery as string) || "png";

      let cacheKey = `${id}:${finalFormat}`;
      if (size) cacheKey += `:${size}`;

      let outputBuffer = await getCache("appIcon", cacheKey);

      if (!outputBuffer) {
        const originalBuffer =
          (await readS3Icon(id)) ?? (await readLocalIcon(id));

        if (!originalBuffer) {
          throw new HttpException(HttpStatusCode.NotFound, "App icon not found");
        }

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
              fit: "cover",
            });
          }

          outputBuffer = await image.toBuffer();
        }

        appIconCache.set(cacheKey, outputBuffer);
      }

      const etag = crypto.createHash("md5").update(outputBuffer).digest("hex");

      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", etag);
      res.setHeader(
        "Content-Type",
        MIME_TYPES[finalFormat] || "application/octet-stream",
      );

      res.status(HttpStatusCode.Success).end(outputBuffer);
    } catch (err) {
      next(err);
    }
  }
}
