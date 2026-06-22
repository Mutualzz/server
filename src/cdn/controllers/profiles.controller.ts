import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getCache, profileImageCache } from "@mutualzz/cache";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, fetchProfileImageSource, s3Client } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import path from "path";
import sharp from "sharp";
import { MIME_TYPES } from "../Constants";
import { contentEtag, normalizeFormat } from "../utils";

const FONT_HASH_RE = /^[a-f0-9]{64}$/i;
const MUSIC_HASH_RE = /^[a-f0-9]{64}$/i;

type ProfileImageKind = "banner" | "background" | "image";

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

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", cacheControl);
  if (ContentLength) {
    res.setHeader("Content-Length", ContentLength.toString());
  }

  const buffer = await Body.transformToByteArray();
  res.status(HttpStatusCode.Success).send(Buffer.from(buffer));
}

async function getProfileImage(
  kind: ProfileImageKind,
  req: Request,
  res: Response,
) {
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

  let targetFormat = normalizeFormat(formatQuery) ?? normalizeFormat(urlExt);

  const animatedQuery = String(animatedQueryRaw ?? "").toLowerCase();
  const explicitAnimated = ["true", "1", "on", "yes"].includes(animatedQuery);
  const explicitStatic = ["false", "0", "off", "no"].includes(animatedQuery);

  if (!targetFormat) {
    targetFormat = isAnimatedHash && explicitAnimated ? "webp" : "png";
  }

  let willAnimate: boolean;
  if (targetFormat === "gif") willAnimate = isAnimatedHash && !explicitStatic;
  else if (targetFormat === "webp")
    willAnimate = isAnimatedHash && explicitAnimated;
  else willAnimate = false;

  if (!willAnimate && targetFormat === "gif") targetFormat = "png";

  const boundedSize = (() => {
    const n = Number(sizeQuery);
    if (!Number.isFinite(n)) return undefined as number | undefined;

    return Math.max(1, Math.min(4096, Math.floor(n)));
  })();

  let cacheKey = `${kind}:${userId}:${baseName}:${targetFormat}`;
  if (boundedSize) cacheKey += `:${boundedSize}`;
  if (willAnimate) cacheKey += `:a`;

  const cached = await getCache("profileImage", cacheKey);
  if (cached) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("ETag", contentEtag(cached));
    res.setHeader(
      "Content-Type",
      MIME_TYPES[targetFormat] || "application/octet-stream",
    );
    res.status(HttpStatusCode.Success).end(Buffer.from(cached));
    return;
  }

  let sourceBody: Uint8Array;
  try {
    sourceBody = await fetchProfileImageSource(userId, baseName, kind);
  } catch {
    throw new HttpException(HttpStatusCode.NotFound, "Profile image not found");
  }

  let image: sharp.Sharp;
  if (willAnimate) image = sharp(sourceBody, { animated: true });
  else image = sharp(sourceBody);

  if (typeof image.toColourspace === "function")
    image = image.toColourspace("srgb");

  if (boundedSize)
    image = image.resize(boundedSize, boundedSize, {
      fit: "inside",
      withoutEnlargement: true,
    });

  let actualFormat: string = targetFormat;

  if (willAnimate) {
    if (targetFormat === "webp") {
      image = image.webp({ quality: 80, loop: 0 });
    } else if (targetFormat === "gif") {
      if (!boundedSize) {
        const etag = contentEtag(sourceBody);
        profileImageCache.set(cacheKey, sourceBody);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.setHeader("ETag", etag);
        res.setHeader("Content-Type", MIME_TYPES["gif"]);
        res.status(HttpStatusCode.Success).end(sourceBody);
        return;
      }

      actualFormat = "webp";
      image = image.webp({ quality: 80, loop: 0 });
    } else {
      actualFormat = "webp";
      image = image.webp({ quality: 80, loop: 0 });
    }
  } else {
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
        actualFormat = "png";
        image = image.png({ compressionLevel: 9 });
        break;
      default:
        actualFormat = "png";
        image = image.png({ compressionLevel: 9 });
    }
  }

  const outputBuffer = await image.toBuffer();

  const etag = contentEtag(outputBuffer);
  profileImageCache.set(cacheKey, outputBuffer);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.setHeader("ETag", etag);
  res.setHeader(
    "Content-Type",
    MIME_TYPES[actualFormat] || "application/octet-stream",
  );

  res.status(HttpStatusCode.Success).end(outputBuffer);
}

export default class ProfilesController {
  static async getBanner(req: Request, res: Response, next: NextFunction) {
    try {
      await getProfileImage("banner", req, res);
    } catch (err) {
      next(err);
    }
  }

  static async getBackground(req: Request, res: Response, next: NextFunction) {
    try {
      await getProfileImage("background", req, res);
    } catch (err) {
      next(err);
    }
  }

  static async getImage(req: Request, res: Response, next: NextFunction) {
    try {
      await getProfileImage("image", req, res);
    } catch (err) {
      next(err);
    }
  }

  static async getFont(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, font } = req.params as {
        userId: string;
        font: string;
      };

      const hash = path.basename(font, path.extname(font));
      if (!FONT_HASH_RE.test(hash)) {
        throw new HttpException(HttpStatusCode.BadRequest, "Invalid font hash");
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
