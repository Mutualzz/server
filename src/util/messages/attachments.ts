import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { APIAttachment } from "@mutualzz/types";
import sharp from "sharp";
import { bucketName, s3Client } from "../S3.ts";
import { Snowflake } from "../Snowflake.ts";

export const uploadMessageAttachments = (
  folderId: string,
  files: Express.Multer.File[],
  spoilers: boolean[],
): Promise<APIAttachment[]> =>
  Promise.all(
    files.map(async (file, index) => {
      const spoiler = spoilers[index] ?? false;
      const attachmentId = Snowflake.generate();
      const originalName =
        typeof file.originalname === "string" ? file.originalname.trim() : "";
      const fallbackExt =
        file.mimetype.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") ||
        "bin";
      const safeName = (originalName || `attachment.${fallbackExt}`).replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
      );
      const key = `attachments/${folderId}/${attachmentId}_${safeName}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Body: file.buffer,
          Key: key,
          ContentType: file.mimetype,
        }),
      );

      let width: number | undefined;
      let height: number | undefined;
      if (file.mimetype.startsWith("image/")) {
        try {
          const meta = await sharp(file.buffer).metadata();
          width = meta.width;
          height = meta.height;
        } catch {
          // ignore dimension errors
        }
      }

      const cdnBase = process.env.CDN_URL ?? "";
      return {
        id: attachmentId,
        filename: originalName || `attachment.${fallbackExt}`,
        size: file.size,
        contentType: file.mimetype,
        url: `${cdnBase}/attachments/${folderId}/${attachmentId}_${safeName}`,
        width,
        height,
        spoiler,
      } satisfies APIAttachment;
    }),
  );

export const readAttachmentSpoilers = (
  body: unknown,
  validatedSpoilers: boolean[],
) => {
  if (validatedSpoilers.length > 0) return validatedSpoilers;

  const rawBody = body as Record<string, unknown>;
  const raw = rawBody["attachmentSpoilers[]"] ?? rawBody.attachmentSpoilers;
  if (raw == null) return [];

  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => value === true || value === "true");
};
