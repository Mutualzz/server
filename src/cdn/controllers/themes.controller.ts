import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getCache, themeBackgroundCache } from "@mutualzz/cache";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import path from "path";
import sharp from "sharp";
import { MIME_TYPES } from "../Constants";
import { contentEtag, normalizeFormat } from "../utils";
import {
  themesGetBackgroundParams,
  themesGetBackgroundQuery,
} from "@mutualzz/validators";

export default class ThemesController {
  static async getBackground(req: Request, res: Response, next: NextFunction) {
    try {
      const { themeId, asset } = themesGetBackgroundParams.parse(req.params);

      const { format, size, animated } = themesGetBackgroundQuery.parse(
        req.query,
      );

      const baseName = path.basename(asset, path.extname(asset));
      const urlExt = path.extname(asset).replace(".", "").toLowerCase();
      const isAnimatedHash = baseName.startsWith("a_");

      let targetFormat = normalizeFormat(format) ?? normalizeFormat(urlExt);

      const explicitAnimated = ["true", "1", "on", "yes"].includes(
        animated?.toString() ?? "",
      );
      const explicitStatic = ["false", "0", "off", "no"].includes(
        animated?.toString() ?? "",
      );

      if (!targetFormat)
        targetFormat = isAnimatedHash && explicitAnimated ? "webp" : "png";

      let willAnimate: boolean;
      if (targetFormat === "gif")
        willAnimate = isAnimatedHash && !explicitStatic;
      else if (targetFormat === "webp")
        willAnimate = isAnimatedHash && explicitAnimated;
      else willAnimate = false;

      if (!willAnimate && targetFormat === "gif") targetFormat = "png";

      let cacheKey = `${themeId}:${baseName}:${targetFormat}`;
      if (size) cacheKey += `:${size}`;
      if (willAnimate) cacheKey += `:a`;

      const cached = await getCache("themeBackground", cacheKey);
      if (cached) {
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.setHeader("ETag", contentEtag(cached));
        res.setHeader(
          "Content-Type",
          MIME_TYPES[targetFormat] || "application/octet-stream",
        );
        res.status(HttpStatusCode.Success).end(Buffer.from(cached));
        return;
      }

      const sourceExt = isAnimatedHash ? "gif" : "png";
      const sourceKey = `themes/${themeId}/background/${baseName}.${sourceExt}`;

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
          "Background not found",
        );
      }

      let image: sharp.Sharp;
      if (willAnimate) image = sharp(sourceBody, { animated: true });
      else image = sharp(sourceBody);

      if (typeof image.toColourspace === "function")
        image = image.toColourspace("srgb");

      if (size)
        image = image.resize(size, size, {
          fit: "inside",
          withoutEnlargement: true,
        });

      let actualFormat: string = targetFormat;

      if (willAnimate) {
        if (targetFormat === "webp") {
          image = image.webp({ quality: 82, loop: 0 });
        } else if (targetFormat === "gif") {
          if (!size) {
            const etag = contentEtag(sourceBody);
            themeBackgroundCache.set(cacheKey, sourceBody);
            res.setHeader(
              "Cache-Control",
              "public, max-age=86400, immutable",
            );
            res.setHeader("ETag", etag);
            res.setHeader("Content-Type", MIME_TYPES["gif"]);
            res.status(HttpStatusCode.Success).end(sourceBody);
            return;
          }
          actualFormat = "webp";
          image = image.webp({ quality: 82, loop: 0 });
        } else {
          actualFormat = "webp";
          image = image.webp({ quality: 82, loop: 0 });
        }
      } else {
        switch (targetFormat) {
          case "png":
            image = image.png({ compressionLevel: 9 });
            break;
          case "webp":
            image = image.webp({ quality: 82 });
            break;
          case "avif":
            image = image.avif({ quality: 50 });
            break;
          case "jpg":
            image = image.jpeg({ mozjpeg: true, quality: 82 });
            break;
          default:
            actualFormat = "png";
            image = image.png({ compressionLevel: 9 });
        }
      }

      const outputBuffer = await image.toBuffer();
      const etag = contentEtag(outputBuffer);
      themeBackgroundCache.set(cacheKey, outputBuffer);

      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("ETag", etag);
      res.setHeader(
        "Content-Type",
        MIME_TYPES[actualFormat] || "application/octet-stream",
      );
      res.status(HttpStatusCode.Success).end(outputBuffer);
    } catch (err) {
      next(err);
    }
  }
}
