import type { NextFunction, Request, Response } from "express";
import path from "path";
import { contentEtag, normalizeFormat } from "@mutualzz/cdn/utils";
import { expressionsCache, getCache } from "@mutualzz/cache";
import { MIME_TYPES } from "@mutualzz/cdn/Constants.ts";
import { bucketName, s3Client } from "@mutualzz/util";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  expressionsGetParams,
  expressionsGetQuery,
} from "@mutualzz/validators";

export default class ExpressionsController {
  static async getExpression(req: Request, res: Response, next: NextFunction) {
    try {
      const { expressionId, assetHash } = expressionsGetParams.parse(
        req.params,
      );

      const { format, size, animated } = expressionsGetQuery.parse(req.query);

      const baseName = path.basename(assetHash, path.extname(assetHash));
      const urlExt = path.extname(assetHash).replace(".", "").toLowerCase();

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

      let cacheKey = `${expressionId}:${baseName}:${targetFormat}`;
      if (size) cacheKey += `:${size}`;
      if (willAnimate) cacheKey += `:a`;

      const cached = await getCache("expressions", cacheKey);
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
      const sourceKey = `expressions/${expressionId}/${baseName}.${sourceExt}`;

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
          "Expression not found",
        );
      }

      let image: sharp.Sharp;
      if (willAnimate) image = sharp(sourceBody, { animated: true });
      else image = sharp(sourceBody);

      if (typeof image.toColourspace === "function")
        image = image.toColourspace("srgb");

      if (size)
        image = image.resize(size, size, {
          fit: "cover",
        });

      let actualFormat: string = targetFormat;

      if (willAnimate) {
        // Animated branch
        if (targetFormat === "webp") {
          image = image.webp({ quality: 80, loop: 0 });
        } else if (targetFormat === "gif") {
          if (!size) {
            const etag = contentEtag(sourceBody);
            expressionsCache.set(cacheKey, sourceBody);
            res.setHeader("Cache-Control", "public, max-age=86400, immutable");
            res.setHeader("ETag", etag);
            res.setHeader("Content-Type", MIME_TYPES["gif"]);
            res.status(HttpStatusCode.Success).end(sourceBody);
            return;
          } else {
            actualFormat = "webp";
            image = image.webp({ quality: 80, loop: 0 });
          }
        } else {
          actualFormat = "webp";
          image = image.webp({ quality: 80, loop: 0 });
        }
      } else {
        // Static branch
        switch (targetFormat) {
          case "png":
            image = image.png({ compressionLevel: 9 });
            break;
          case "webp":
            image = image.webp({ quality: 80 });
            break;
          case "avif":
            image = image.avif({ quality: 50 });
            break;
          case "jpg":
            image = image.jpeg({ mozjpeg: true, quality: 82 });
            break;
          case "gif":
            // This shouldn't happen due to prior logic, but just in case
            actualFormat = "png";
            image = image.png({ compressionLevel: 9 });
            break;
          default:
            actualFormat = "png";
            image = image.png({ compressionLevel: 9 });
        }
      }

      let outputBuffer: Buffer;
      try {
        outputBuffer = await image.toBuffer();
      } catch (encodeErr) {
        if (!willAnimate) throw encodeErr;

        actualFormat = "gif";
        outputBuffer = Buffer.from(sourceBody);
      }

      const etag = contentEtag(outputBuffer);
      expressionsCache.set(cacheKey, outputBuffer);

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
