import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  APIMobileProfileBlock,
  APIProfileBlock,
  APIProfileMusic,
  APIProfileTheme,
  APIDisplayNameStyle,
  APIUserProfile,
  ProfileBackgroundImageFit,
  APIBadgeSettings,
} from "@mutualzz/types";
import { generateHash } from "./Common";
import { bucketName, s3Client } from "./S3";

export const PROFILE_ASSET_HASH_RE = /^[a-f0-9_]+$/i;
export const PROFILE_FONT_HASH_RE = /^[a-f0-9]{64}$/i;

export const PROFILE_FONT_EXTENSIONS = ["woff2", "woff", "ttf", "otf"] as const;
export type ProfileFontExt = (typeof PROFILE_FONT_EXTENSIONS)[number];

const PROFILE_FONT_REF_RE = /^([a-f0-9]{64})(?:\.(woff2|woff|ttf|otf))?$/i;

export const PROFILE_IMAGE_KINDS = ["banner", "background", "image"] as const;

export type ProfileImageKind = (typeof PROFILE_IMAGE_KINDS)[number];

export const isProfileConfigured = (profile: {
  blocks: unknown[];
  backgroundImage?: string | null;
  backgroundColor?: string | null;
  banner?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  profileMusic?: APIProfileMusic | null;
}) =>
  profile.blocks.length > 0 ||
  !!profile.backgroundImage ||
  !!profile.backgroundColor ||
  !!profile.banner ||
  !!profile.bio ||
  !!profile.pronouns ||
  !!profile.profileMusic;

export interface UserProfileRow {
  userId: bigint;
  configured: boolean;
  backgroundColor: string | null;
  backgroundImage: string | null;
  backgroundImageFit: ProfileBackgroundImageFit | null;
  banner: string | null;
  bio: string | null;
  pageFontFamily: string | null;
  theme: APIProfileTheme | null;
  displayNameStyle: APIDisplayNameStyle | null;
  badgeSettings: APIBadgeSettings | null;
  profileMusic: APIProfileMusic | null;
  blocks: APIProfileBlock[];
  mobileBlocks: APIMobileProfileBlock[];
  updatedAt: Date;
}

export function mapUserProfileRow(
  row: UserProfileRow,
  pronouns?: string | null,
): APIUserProfile {
  const blocks = row.blocks ?? [];
  return {
    userId: row.userId.toString(),
    configured: isProfileConfigured({
      blocks,
      backgroundImage: row.backgroundImage,
      backgroundColor: row.backgroundColor,
      banner: row.banner,
      bio: row.bio,
      pronouns: pronouns ?? null,
      profileMusic: row.profileMusic,
    }),
    backgroundColor: row.backgroundColor,
    backgroundImage: row.backgroundImage,
    backgroundImageFit: row.backgroundImageFit ?? null,
    banner: row.banner,
    bio: row.bio,
    pronouns: pronouns ?? null,
    pageFontFamily: row.pageFontFamily,
    theme: row.theme,
    displayNameStyle: row.displayNameStyle,
    badgeSettings: row.badgeSettings,
    profileMusic: row.profileMusic,
    blocks,
    mobileBlocks: row.mobileBlocks ?? [],
    updatedAt: row.updatedAt,
  };
}

export interface ProfileAssetRefs {
  images: Set<string>;
  music: Set<string>;
  fonts: Set<string>;
}

export interface ProfileAssetSource {
  images?: string[];
  banner?: string | null;
  backgroundImage?: string | null;
  pageFontFamily?: string | null;
  displayNameStyle?: APIDisplayNameStyle | null;
  profileMusic?: APIProfileMusic | null;
  blocks?: APIProfileBlock[] | unknown[];
  mobileBlocks?: APIMobileProfileBlock[] | unknown[];
}

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

export const profileImageKindKey = (
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
  return [
    `profiles/${userId}/image/${hash}.${ext}`,
    profileImageKindKey(userId, hash, preferredKind),
  ];
};

export const profileMusicKey = (userId: string, hash: string): string =>
  `profiles/${userId}/music/${hash}.mp3`;

export const profileFontKey = (
  userId: string,
  hash: string,
  ext: ProfileFontExt = "woff2",
): string => `profiles/${userId}/fonts/${hash}.${ext}`;

export const parseFontRef = (
  pageFontFamily: string | null | undefined,
): { hash: string; ext: ProfileFontExt } | null => {
  if (!pageFontFamily?.startsWith("font:")) return null;
  const rest = pageFontFamily.slice("font:".length);
  const match = PROFILE_FONT_REF_RE.exec(rest);
  if (!match) return null;
  return {
    hash: match[1],
    ext: (match[2]?.toLowerCase() ?? "woff2") as ProfileFontExt,
  };
};

export const parseFontHash = (
  pageFontFamily: string | null | undefined,
): string | null => parseFontRef(pageFontFamily)?.hash ?? null;

export const collectProfileAssetRefs = (
  profile: ProfileAssetSource,
): ProfileAssetRefs => {
  const images = new Set<string>();
  const music = new Set<string>();
  const fonts = new Set<string>();

  for (const imageHash of profile.images ?? []) {
    if (isProfileAssetHash(imageHash)) images.add(imageHash);
  }

  if (isProfileAssetHash(profile.banner)) images.add(profile.banner);
  if (isProfileAssetHash(profile.backgroundImage)) {
    images.add(profile.backgroundImage);
  }

  const fontRef = parseFontRef(profile.pageFontFamily);
  if (fontRef) fonts.add(`${fontRef.hash}.${fontRef.ext}`);

  const nameFontRef = parseFontRef(profile.displayNameStyle?.font);
  if (nameFontRef) fonts.add(`${nameFontRef.hash}.${nameFontRef.ext}`);

  const audioHash = profile.profileMusic?.audioHash;
  if (isProfileAssetHash(audioHash)) music.add(audioHash);

  for (const block of profile.blocks ?? []) {
    const candidate = block as {
      type?: string;
      src?: string;
      images?: { src?: string }[];
      appearance?: { font?: string | null } | null;
    };
    if (candidate.type === "image" && isProfileAssetHash(candidate.src)) {
      images.add(candidate.src);
    }

    if (candidate.type === "gallery") {
      for (const galleryImage of candidate.images ?? []) {
        if (isProfileAssetHash(galleryImage.src)) images.add(galleryImage.src);
      }
    }

    const blockFontRef = parseFontRef(candidate.appearance?.font);
    if (blockFontRef) fonts.add(`${blockFontRef.hash}.${blockFontRef.ext}`);
  }

  for (const block of profile.mobileBlocks ?? []) {
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
      // ignore
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

const mergeProfileAssetRefs = (
  sources: (ProfileAssetSource | null | undefined)[],
): ProfileAssetRefs => {
  const merged: ProfileAssetRefs = {
    images: new Set(),
    music: new Set(),
    fonts: new Set(),
  };

  for (const source of sources) {
    if (!source) continue;
    const refs = collectProfileAssetRefs(source);
    for (const hash of refs.images) merged.images.add(hash);
    for (const hash of refs.music) merged.music.add(hash);
    for (const token of refs.fonts) merged.fonts.add(token);
  }

  return merged;
};

export const cleanupOrphanedProfileAssets = async (
  userId: string,
  previousSources: (ProfileAssetSource | null | undefined)[],
  nextSources: (ProfileAssetSource | null | undefined)[],
): Promise<void> => {
  const previousRefs = mergeProfileAssetRefs(previousSources);
  const nextRefs = mergeProfileAssetRefs(nextSources);

  const keysToDelete: string[] = [];

  for (const hash of previousRefs.images) {
    if (nextRefs.images.has(hash)) continue;
    keysToDelete.push(profileImageKey(userId, hash));
    for (const kind of PROFILE_IMAGE_KINDS) {
      keysToDelete.push(profileImageKindKey(userId, hash, kind));
    }
  }

  for (const hash of previousRefs.music) {
    if (nextRefs.music.has(hash)) continue;
    keysToDelete.push(profileMusicKey(userId, hash));
  }

  for (const token of previousRefs.fonts) {
    if (nextRefs.fonts.has(token)) continue;
    const [hash, ext] = token.split(".") as [string, ProfileFontExt];
    keysToDelete.push(profileFontKey(userId, hash, ext));
  }

  await Promise.all(keysToDelete.map((key) => deleteS3Object(key)));
};
