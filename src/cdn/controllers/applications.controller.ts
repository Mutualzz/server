import { GetObjectCommand } from "@aws-sdk/client-s3";
import { appIconCache, getCache } from "@mutualzz/cache";
import { applicationsTable, db } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { applicationIconS3Key, bucketName, s3Client } from "@mutualzz/util";
import {
  applicationsGetIconParams,
  applicationsGetIconQuery,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp, { type FormatEnum } from "sharp";
import { MIME_TYPES } from "../Constants";
import { contentEtag, normalizeFormat } from "../utils";

export async function findApplicationIconHash(applicationId: string) {
  if (!/^\d{1,19}$/.test(applicationId)) return undefined;

  const row = await db.query.applicationsTable.findFirst({
    columns: { icon: true },
    where: eq(applicationsTable.id, BigInt(applicationId)),
  });

  // undefined = not an application, null = application without an icon
  return row ? row.icon : undefined;
}

export async function renderApplicationIcon(
  applicationId: string,
  hash: string,
  format?: string,
  size?: number,
) {
  const targetFormat = normalizeFormat(format) ?? "png";
  let cacheKey = `app:${applicationId}:${hash}:${targetFormat}`;
  if (size) cacheKey += `:${size}`;

  const cached = await getCache("appIcon", cacheKey);
  if (cached) return { buffer: cached, format: targetFormat };

  let source: Uint8Array;
  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: applicationIconS3Key(applicationId, hash),
      }),
    );
    if (!Body) throw new Error("Empty body");
    source = await Body.transformToByteArray();
  } catch {
    throw new HttpException(HttpStatusCode.NotFound, "Icon not found");
  }

  const outputFormat = targetFormat === "gif" ? "png" : targetFormat;

  let image = sharp(source);
  if (size) image = image.resize({ width: size, height: size, fit: "cover" });
  image = image.toFormat(outputFormat as keyof FormatEnum);

  const buffer = await image.toBuffer();
  appIconCache.set(cacheKey, buffer);

  return { buffer, format: outputFormat };
}

export function sendIcon(
  res: Response,
  buffer: Uint8Array,
  format: string,
  cacheControl: string,
) {
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("ETag", contentEtag(buffer));
  res.setHeader(
    "Content-Type",
    MIME_TYPES[format] || "application/octet-stream",
  );
  res.status(HttpStatusCode.Success).end(Buffer.from(buffer));
}

export default class ApplicationsController {
  static async getIcon(req: Request, res: Response, next: NextFunction) {
    try {
      const { applicationId, icon } = applicationsGetIconParams.parse(
        req.params,
      );
      const { format, size } = applicationsGetIconQuery.parse(req.query);

      const result = await renderApplicationIcon(
        applicationId,
        icon,
        format,
        size,
      );

      // The hash is in the URL, so this URL's content never changes
      sendIcon(
        res,
        result.buffer,
        result.format,
        "public, max-age=31536000, immutable",
      );
    } catch (err) {
      next(err);
    }
  }
}
