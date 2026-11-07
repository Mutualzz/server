import crypto from "node:crypto";
import sharp from "sharp";
import { redis } from "./Redis";

const ART_SIZE = 128;
const ART_TTL_SEC = 2 * 60 * 60;
const MAX_INPUT_PIXELS = 1024 * 1024;
const PATH_PREFIX = "/activity-art/";
const FILE_PATTERN = /^[a-f0-9]{32}\.webp$/;

const artKey = (hash: string) => `activity-art:${hash}`;

function cdnBase() {
  return process.env.CDN_URL?.trim().replace(/\/+$/, "") || null;
}

export async function storeActivityArt(base64: string): Promise<string | null> {
  const base = cdnBase();
  if (!base) return null;

  const output = await sharp(Buffer.from(base64, "base64"), {
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .resize({ width: ART_SIZE, height: ART_SIZE, fit: "cover" })
    .webp({ quality: 80 })
    .toBuffer();

  const hash = crypto
    .createHash("sha256")
    .update(output)
    .digest("hex")
    .slice(0, 32);

  await redis.set(artKey(hash), output, "EX", ART_TTL_SEC);
  return `${base}${PATH_PREFIX}${hash}.webp`;
}

export async function getActivityArt(file: string): Promise<Buffer | null> {
  if (!FILE_PATTERN.test(file)) return null;
  return redis.getBuffer(artKey(file.slice(0, 32)));
}

export function isActivityArtUrl(url: unknown): url is string {
  const base = cdnBase();
  if (!base || typeof url !== "string") return false;
  if (!url.startsWith(base + PATH_PREFIX)) return false;
  return FILE_PATTERN.test(url.slice(base.length + PATH_PREFIX.length));
}
