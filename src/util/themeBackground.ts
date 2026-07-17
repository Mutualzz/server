import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { bucketName, generateHash, s3Client } from "@mutualzz/util";
import { imageFileValidator } from "@mutualzz/validators";
import sharp from "sharp";

export function themeBackgroundS3Key(themeId: string, hash: string) {
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `themes/${themeId}/background/${hash}.${ext}`;
}

export async function uploadThemeBackgroundImage(
  themeId: string,
  file: Express.Multer.File,
  previousHash?: string | null,
) {
  const imageFile = imageFileValidator.parse(file);
  const isGif = imageFile.mimetype === "image/gif";

  let imageSharp: sharp.Sharp;
  if (isGif) imageSharp = sharp(imageFile.buffer, { animated: true });
  else imageSharp = sharp(imageFile.buffer).toFormat("png");

  const metadata = await imageSharp.metadata();
  const maxEdge = 4096;
  if (
    (metadata.width && metadata.width > maxEdge) ||
    (metadata.height && metadata.height > maxEdge)
  ) {
    imageSharp = imageSharp.resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const buffer = await imageSharp.toBuffer();
  const hash = generateHash(buffer, isGif);
  const storedExt = isGif ? "gif" : "png";

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Body: buffer,
      Key: themeBackgroundS3Key(themeId, hash),
      ContentType: isGif ? "image/gif" : "image/png",
    }),
  );

  if (previousHash && previousHash !== hash) {
    await deleteThemeBackgroundImage(themeId, previousHash);
  }

  return hash;
}

export async function deleteThemeBackgroundImage(
  themeId: string,
  hash: string,
) {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: themeBackgroundS3Key(themeId, hash),
      }),
    );
  } catch {
    // ignore missing object
  }
}
