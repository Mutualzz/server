import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { APIProfileBlock, APIProfileMusic } from "@mutualzz/types";
import { generateHash } from "./Common";
import { bucketName, s3Client } from "./S3";

export const PROFILE_ASSET_HASH_RE = /^[a-f0-9_]+$/i;
export const PROFILE_FONT_HASH_RE = /^[a-f0-9]{64}$/i;

export const LEGACY_PROFILE_IMAGE_KINDS = [
  "banner",
  "background",
  "image",
] as const;

export type ProfileImageKind = (typeof LEGACY_PROFILE_IMAGE_KINDS)[number];

export type ProfileAssetRefs = {
  images: Set<string>;
  music: Set<string>;
  fonts: Set<string>;
};

type ProfileAssetSource = {
  banner?: string | null;
  backgroundImage?: string | null;
  pageFontFamily?: string | null;
  profileMusic?: APIProfileMusic | null;
  blocks?: APIProfileBlock[] | unknown[];
};

export const isProfileAssetHash = (
  value: string | null | undefined,
): value is string => {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return false;
  }
  return PROFILE_ASSET_HASH_RE.test(value);
};

export const profileImageExt = (hash: string): "gif" | "png" =>
  hash.startsWith("a_") ? "gif" : "png";

export const profileImageKey = (userId: string, hash: string): string =>
  `profiles/${userId}/image/${hash}.${profileImageExt(hash)}`;

export const legacyProfileImageKey = (
  userId: string,
  hash: string,
  kind: ProfileImageKind,
): string => `profiles/${userId}/${kind}/${hash}.${profileImageExt(hash)}`;

export const profileImageSourceKeys = (
  userId: string,
  hash: string,
  preferredKind: ProfileImageKind,
): string[] => {
  const ext = profileImageExt(hash);
  const baseName = hash;
  const seen = new Set<string>();
  const keys: string[] = [];

  const push = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  push(`profiles/${userId}/image/${baseName}.${ext}`);
  push(`profiles/${userId}/${preferredKind}/${baseName}.${ext}`);

  for (const kind of LEGACY_PROFILE_IMAGE_KINDS) {
    if (kind === preferredKind) continue;
    push(`profiles/${userId}/${kind}/${baseName}.${ext}`);
  }

  return keys;
};

export const profileMusicKey = (userId: string, hash: string): string =>
  `profiles/${userId}/music/${hash}.mp3`;

export const profileFontKey = (userId: string, hash: string): string =>
  `profiles/${userId}/fonts/${hash}.woff2`;

export const parseFontHash = (
  pageFontFamily: string | null | undefined,
): string | null => {
  if (!pageFontFamily?.startsWith("font:")) return null;
  const hash = pageFontFamily.slice("font:".length);
  return PROFILE_FONT_HASH_RE.test(hash) ? hash : null;
};

export const collectProfileAssetRefs = (
  profile: ProfileAssetSource,
): ProfileAssetRefs => {
  const images = new Set<string>();
  const music = new Set<string>();
  const fonts = new Set<string>();

  if (isProfileAssetHash(profile.banner)) images.add(profile.banner);
  if (isProfileAssetHash(profile.backgroundImage)) {
    images.add(profile.backgroundImage);
  }

  const fontHash = parseFontHash(profile.pageFontFamily);
  if (fontHash) fonts.add(fontHash);

  const audioHash = profile.profileMusic?.audioHash;
  if (isProfileAssetHash(audioHash)) music.add(audioHash);

  for (const block of profile.blocks ?? []) {
    const candidate = block as { type?: string; src?: string };
    if (candidate.type === "image" && isProfileAssetHash(candidate.src)) {
      images.add(candidate.src);
    }
  }

  return { images, music, fonts };
};

const ensureS3Object = async (
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> => {
  try {
    await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
  } catch {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Body: body,
        Key: key,
        ContentType: contentType,
      }),
    );
  }
};

export const ensureProfileImage = async (
  userId: string,
  buffer: Buffer | Uint8Array,
  isGif: boolean,
): Promise<string> => {
  const hash = generateHash(buffer, isGif);
  await ensureS3Object(
    profileImageKey(userId, hash),
    buffer,
    isGif ? "image/gif" : "image/png",
  );
  return hash;
};

export const fetchProfileImageSource = async (
  userId: string,
  hash: string,
  preferredKind: ProfileImageKind,
): Promise<Uint8Array> => {
  for (const key of profileImageSourceKeys(userId, hash, preferredKind)) {
    try {
      const { Body } = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: key,
        }),
      );
      if (!Body) continue;
      return await Body.transformToByteArray();
    } catch {
      // Try the next legacy location.
    }
  }

  throw new Error("Profile image not found");
};

const deleteS3Object = async (key: string): Promise<void> => {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
  } catch {
    // Object may already be gone.
  }
};

export const cleanupOrphanedProfileAssets = async (
  userId: string,
  previous: ProfileAssetSource | null | undefined,
  next: ProfileAssetSource,
): Promise<void> => {
  const previousRefs = collectProfileAssetRefs(previous ?? {});
  const nextRefs = collectProfileAssetRefs(next);

  const keysToDelete: string[] = [];

  for (const hash of previousRefs.images) {
    if (nextRefs.images.has(hash)) continue;
    keysToDelete.push(profileImageKey(userId, hash));
    for (const kind of LEGACY_PROFILE_IMAGE_KINDS) {
      keysToDelete.push(legacyProfileImageKey(userId, hash, kind));
    }
  }

  for (const hash of previousRefs.music) {
    if (nextRefs.music.has(hash)) continue;
    keysToDelete.push(profileMusicKey(userId, hash));
  }

  for (const hash of previousRefs.fonts) {
    if (nextRefs.fonts.has(hash)) continue;
    keysToDelete.push(profileFontKey(userId, hash));
  }

  await Promise.all(keysToDelete.map((key) => deleteS3Object(key)));
};
