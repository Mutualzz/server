import { GetObjectCommand } from "@aws-sdk/client-s3";
import { badgeFlags } from "@mutualzz/bitfield";
import { badgeCache, getCache } from "@mutualzz/cache";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import { badgesGetParams, badgesGetQuery } from "@mutualzz/validators";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { readFile } from "fs/promises";
import path from "path";
import sharp, { type FormatEnum } from "sharp";
import { MIME_TYPES } from "../Constants";

const LOCAL_ASSETS_DIR = path.join(
  import.meta.dirname,
  "../../../assets/badges",
);

const DEFAULT_RASTER_SIZE = 128;

async function readLocalBadge(id: string) {
  try {
    return await readFile(path.join(LOCAL_ASSETS_DIR, `${id}.svg`));
  } catch {
    return null;
  }
}

async function readS3Badge(id: string) {
  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `badges/${id}.svg`,
      }),
    );
    if (!Body) return null;
    return Buffer.from(await Body.transformToByteArray());
  } catch {
    return null;
  }
}

export default class BadgesController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = badgesGetParams.parse(req.params);
      const { format, size } = badgesGetQuery.parse(req.query);

      if (!(badgeFlags as readonly string[]).includes(id))
        throw new HttpException(HttpStatusCode.NotFound, "Badge not found");

      const outputFormat = format ?? "svg";

      let cacheKey = `${id}:${outputFormat}`;
      if (size) cacheKey += `:${size}`;

      let outputBuffer = await getCache("badge", cacheKey);

      if (!outputBuffer) {
        const originalBuffer =
          (await readS3Badge(id)) ?? (await readLocalBadge(id));

        if (!originalBuffer)
          throw new HttpException(HttpStatusCode.NotFound, "Badge not found");

        if (outputFormat === "svg") {
          outputBuffer = originalBuffer;
        } else {
          const targetSize = size ?? DEFAULT_RASTER_SIZE;
          outputBuffer = await sharp(originalBuffer, { density: 288 })
            .resize({
              width: targetSize,
              height: targetSize,
              fit: "contain",
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .toFormat(outputFormat as keyof FormatEnum)
            .toBuffer();
        }

        badgeCache.set(cacheKey, outputBuffer);
      }

      const etag = crypto.createHash("md5").update(outputBuffer).digest("hex");

      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("ETag", etag);
      res.setHeader(
        "Content-Type",
        MIME_TYPES[outputFormat] || "application/octet-stream",
      );
      if (outputFormat === "svg")
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        );

      res.status(HttpStatusCode.Success).end(outputBuffer);
    } catch (err) {
      next(err);
    }
  }
}
