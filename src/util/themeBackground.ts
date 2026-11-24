import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { bucketName, generateHash, s3Client } from "@mutualzz/util";
import { imageFileValidator } from "@mutualzz/validators";
import ffmpegPath from "ffmpeg-static";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const VIDEO_MAX_WIDTH = 1920;
const VIDEO_TIMEOUT_MS = 120_000;

export function themeBackgroundS3Key(themeId: string, hash: string) {
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `themes/${themeId}/background/${hash}.${ext}`;
}

export function themeBackgroundVideoS3Key(themeId: string, hash: string) {
  return `themes/${themeId}/background/${hash}.mp4`;
}

export async function convertGifToMp4(gif: Uint8Array): Promise<Buffer | null> {
  if (!ffmpegPath) return null;
  const directory = await mkdtemp(join(tmpdir(), "mz-wallpaper-"));
  const inputPath = join(directory, "input.gif");
  const outputPath = join(directory, "output.mp4");
  try {
    await writeFile(inputPath, gif);
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        `scale='trunc(min(${VIDEO_MAX_WIDTH},iw)/2)*2':-2:flags=lanczos`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        outputPath,
      ],
      { timeout: VIDEO_TIMEOUT_MS },
    );
    return await readFile(outputPath);
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

  if (isGif) {
    const video = await convertGifToMp4(imageFile.buffer);
    if (video) {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Body: video,
          Key: themeBackgroundVideoS3Key(themeId, hash),
          ContentType: "video/mp4",
        }),
      );
    }
  }

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
  if (!hash.startsWith("a_")) return;
  await s3Client
    .send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: themeBackgroundVideoS3Key(themeId, hash),
      }),
    )
    .catch(() => undefined);
}
