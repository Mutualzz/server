import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { imageFileValidator } from "@mutualzz/validators";
import sharp from "sharp";
import { generateHash } from "./Common";
import { bucketName, s3Client } from "./S3";

export const APPLICATION_ICON_HASH_RE = /^[a-f0-9]{64}$/i;

export function applicationIconS3Key(applicationId: string, hash: string) {
  return `applications/${applicationId}/${hash}.png`;
}

// Icons are always stored as a 512px square PNG (presence icons are never animated)
export async function uploadApplicationIcon(
  applicationId: string,
  file: Express.Multer.File,
  previousHash?: string | null,
) {
  const imageFile = imageFileValidator.parse(file);

  const buffer = await sharp(imageFile.buffer)
    .resize({ width: 512, height: 512, fit: "cover" })
    .png()
    .toBuffer();
  const hash = generateHash(buffer);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Body: buffer,
      Key: applicationIconS3Key(applicationId, hash),
      ContentType: "image/png",
    }),
  );

  if (previousHash && previousHash !== hash) {
    await deleteApplicationIcon(applicationId, previousHash);
  }

  return hash;
}

export async function deleteApplicationIcon(
  applicationId: string,
  hash: string,
) {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: applicationIconS3Key(applicationId, hash),
      }),
    );
  } catch {
    // ignore missing object
  }
}
