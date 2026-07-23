import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { setCache } from "@mutualzz/cache";
import {
  db,
  toPublicUser,
  userProfilesTable,
  usersTable,
} from "@mutualzz/database";
import type {
  APIPrivateUser,
  APIProfileMusic,
  APIUserProfile,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  buildEmbed,
  bucketName,
  cleanupOrphanedProfileAssets,
  ensureProfileImage,
  profileFontKey,
  lookupDeezerTrack,
  lookupItunesTrack,
  emitEvent,
  execNormalized,
  fireAndForget,
  fireAndForgetAll,
  generateHash,
  resolveUserIdentifier,
  s3Client,
  hydrateUserProfileMusicPreviews,
  resolveSearchTrackPreviewUrl,
  searchDeezerTracks,
  searchItunesTracks,
  toDeezerMusicSearchTrack,
  toProfileMusicFromDeezerTrack,
  toProfileMusicFromItunesTrack,
  toMusicSearchTrack,
  assertUserVisible,
} from "@mutualzz/util";
import {
  fontExtFromFile,
  fontFileValidator,
  imageFileValidator,
  profileMusicFileValidator,
  validateProfileAssetUpload,
  validateProfileGet,
  validateProfileMusicPreview,
  validateProfileMusicSearch,
  validateProfileUpdate,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { assertCanViewUserProfile } from "@mutualzz/util/privacy.ts";

const FONT_CONTENT_TYPES: Record<"woff2" | "woff" | "ttf" | "otf", string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

const toAPIUserProfile = (
  row: typeof userProfilesTable.$inferSelect,
  pronouns?: string | null,
): APIUserProfile => ({
  userId: row.userId.toString(),
  configured: row.configured,
  backgroundColor: row.backgroundColor,
  backgroundImage: row.backgroundImage,
  banner: row.banner,
  bio: row.bio,
  pronouns: pronouns ?? null,
  pageFontFamily: row.pageFontFamily,
  profileMusic: row.profileMusic,
  blocks: row.blocks,
  mobileBlocks: row.mobileBlocks,
  updatedAt: row.updatedAt,
});

const emptyProfile = (
  userId: string,
  pronouns?: string | null,
): APIUserProfile => ({
  userId,
  configured: false,
  backgroundColor: null,
  backgroundImage: null,
  banner: null,
  bio: null,
  pronouns: pronouns ?? null,
  pageFontFamily: null,
  profileMusic: null,
  blocks: [],
  mobileBlocks: [],
  updatedAt: new Date(),
});

const isConfigured = (profile: {
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

const resolveProfileMusic = async (input: {
  profileMusicUrl?: string | null;
  profileMusicTrackId?: string | null;
  profileMusicTrackSource?: "itunes" | "deezer" | null;
  profileMusicTitle?: string | null;
  profileMusicAuthorName?: string | null;
}): Promise<APIProfileMusic | null> => {
  if (input.profileMusicTrackId) {
    const source = input.profileMusicTrackSource ?? "itunes";

    if (source === "deezer") {
      const track = await lookupDeezerTrack(input.profileMusicTrackId);
      if (!track) {
        throw new HttpException(HttpStatusCode.BadRequest, "Track not found");
      }
      return toProfileMusicFromDeezerTrack(track);
    }

    const track = await lookupItunesTrack(input.profileMusicTrackId).catch(
      () => null,
    );
    if (!track)
      throw new HttpException(HttpStatusCode.BadRequest, "Track not found");

    return toProfileMusicFromItunesTrack(track);
  }

  const ref = input.profileMusicUrl;
  if (!ref) return null;

  if (/^[a-f0-9_]+$/i.test(ref)) {
    return {
      url: ref,
      audioHash: ref,
      title: input.profileMusicTitle?.trim() || "Profile music",
      authorName: input.profileMusicAuthorName?.trim() || null,
    };
  }

  const embed = await buildEmbed(ref);
  if (!embed?.spotify && !embed?.youtube && !embed?.apple) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Profile music must be a searched track, MP3 upload, or YouTube / Apple Music link",
    );
  }

  return {
    url: ref,
    title: embed.title ?? null,
    image: embed.image ?? null,
    authorName: embed.author?.name ?? null,
    previewUrl: null,
    spotify: embed.spotify,
    youtube: embed.youtube,
    apple: embed.apple,
  };
};

export default class ProfileController {
  private static async sendProfile(
    res: Response,
    userId: string,
    pronouns?: string | null,
  ) {
    const profile = await execNormalized<
      typeof userProfilesTable.$inferSelect | null
    >(
      db.query.userProfilesTable.findFirst({
        where: eq(userProfilesTable.userId, BigInt(userId)),
      }),
    );

    if (!profile) {
      return res
        .status(HttpStatusCode.Success)
        .json(emptyProfile(userId, pronouns ?? null));
    }

    const apiProfile = await hydrateUserProfileMusicPreviews(
      toAPIUserProfile(profile, pronouns ?? null),
    );
    return res.status(HttpStatusCode.Success).json(apiProfile);
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { identifier } = validateProfileGet.parse(req.params);

      const user = await resolveUserIdentifier(identifier);
      if (!user)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const viewerId = req.user?.id;

      if (viewerId && String(viewerId) !== String(user.id)) {
        await assertUserVisible(viewerId, user.id);
      }

      await assertCanViewUserProfile(viewerId, user.id);

      return ProfileController.sendProfile(res, user.id, user.pronouns ?? null);
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }

      return ProfileController.sendProfile(
        res,
        String(req.user.id),
        req.user.pronouns ?? null,
      );
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const body = validateProfileUpdate.parse(req.body);

      const profileMusic = await resolveProfileMusic({
        profileMusicUrl: body.profileMusicUrl,
        profileMusicTrackId: body.profileMusicTrackId,
        profileMusicTrackSource: body.profileMusicTrackSource ?? null,
        profileMusicTitle: body.profileMusicTitle ?? null,
        profileMusicAuthorName: body.profileMusicAuthorName ?? null,
      });

      const existing = await execNormalized<
        typeof userProfilesTable.$inferSelect | null
      >(
        db.query.userProfilesTable.findFirst({
          where: eq(userProfilesTable.userId, BigInt(user.id)),
        }),
      );

      const normalizedBlocks = body.blocks.map((block) => {
        if (block.type === "draw") {
          return {
            ...block,
            svgData: block.svgData ?? null,
            paths: block.paths ?? null,
            backgroundColor: block.backgroundColor ?? null,
          };
        }

        return block;
      });

      const normalizedMobileBlocks = body.mobileBlocks.map((block) => {
        if (block.type === "draw") {
          return {
            ...block,
            svgData: block.svgData ?? null,
            paths: block.paths ?? null,
            backgroundColor: block.backgroundColor ?? null,
          };
        }

        return block;
      });

      const pronouns = body.pronouns ?? null;

      const payload = {
        backgroundColor: body.backgroundColor ?? null,
        backgroundImage: body.backgroundImage ?? null,
        banner: body.banner ?? null,
        bio: body.bio ?? null,
        pageFontFamily: body.pageFontFamily ?? null,
        profileMusic,
        blocks: normalizedBlocks,
        mobileBlocks: normalizedMobileBlocks,
        configured: isConfigured({
          blocks: normalizedBlocks,
          backgroundColor: body.backgroundColor ?? null,
          backgroundImage: body.backgroundImage ?? null,
          banner: body.banner ?? null,
          bio: body.bio ?? null,
          pronouns,
          profileMusic,
        }),
        updatedAt: new Date(),
      };

      const updated = await execNormalized<
        typeof userProfilesTable.$inferSelect | null
      >(
        db
          .insert(userProfilesTable)
          .values({
            userId: BigInt(user.id),
            ...payload,
          })
          .onConflictDoUpdate({
            target: userProfilesTable.userId,
            set: payload,
          })
          .returning()
          .then((rows) => rows[0] ?? null),
      );

      if (!updated) {
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update profile",
        );
      }

      const updatedUser = await execNormalized<APIPrivateUser | null>(
        db
          .update(usersTable)
          .set({ pronouns })
          .where(eq(usersTable.id, BigInt(user.id)))
          .returning()
          .then((rows) => rows[0] ?? null),
      );

      if (!updatedUser) {
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update pronouns",
        );
      }

      const publicUser = toPublicUser(updatedUser);

      const apiProfile = await hydrateUserProfileMusicPreviews(
        toAPIUserProfile(updated, pronouns),
      );

      res.status(HttpStatusCode.Success).json(apiProfile);

      fireAndForgetAll([
        {
          label: "event:UserProfileUpdate",
          run: () =>
            emitEvent({
              event: "UserProfileUpdate",
              user_id: user.id,
              data: apiProfile,
            }),
          meta: { userId: user.id },
        },
        {
          label: "event:UserUpdate",
          run: () =>
            emitEvent({
              event: "UserUpdate",
              user_id: user.id,
              data: publicUser,
            }),
          meta: { userId: user.id },
        },
        {
          label: "cache:update:user",
          run: () => setCache("user", user.id, publicUser),
          meta: { userId: user.id },
        },
        {
          label: "cache:update:authUser",
          run: () => setCache("authUser", user.id, updatedUser),
          meta: { userId: user.id },
        },
      ]);

      fireAndForget(
        () => cleanupOrphanedProfileAssets(user.id, existing, payload),
        {
          label: "profile:cleanupOrphanedAssets",
          meta: { userId: user.id },
        },
      );
    } catch (err) {
      next(err);
    }
  }

  static async searchMusic(req: Request, res: Response, next: NextFunction) {
    try {
      const { q, limit, source } = validateProfileMusicSearch.parse(req.query);
      const searchLimit = Math.min(limit, 10);

      const itunes =
        source === "itunes" || source === "all"
          ? (await searchItunesTracks(q, searchLimit)).map(toMusicSearchTrack)
          : [];

      const deezer =
        source === "deezer" || source === "all"
          ? (await searchDeezerTracks(q, searchLimit)).map(
              toDeezerMusicSearchTrack,
            )
          : [];

      const merged = [...itunes, ...deezer];
      const tracks = merged.slice(0, searchLimit);

      return res.status(HttpStatusCode.Success).json({ tracks });
    } catch (err) {
      next(err);
    }
  }

  static async previewMusic(req: Request, res: Response, next: NextFunction) {
    try {
      const { source, id } = validateProfileMusicPreview.parse(req.query);
      const previewUrl = await resolveSearchTrackPreviewUrl(source, id);
      if (!previewUrl) {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Preview not available for this track",
        );
      }
      return res.status(HttpStatusCode.Success).json({ previewUrl });
    } catch (err) {
      next(err);
    }
  }

  static async uploadAsset(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      if (!req.file) {
        throw new HttpException(HttpStatusCode.BadRequest, "No file uploaded");
      }

      const { type } = validateProfileAssetUpload.parse(req.query);

      switch (type) {
        case "music": {
          const file = profileMusicFileValidator.parse(req.file);
          const hash = generateHash(file.buffer, false);
          const key = `profiles/${user.id}/music/${hash}.mp3`;

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
                Body: file.buffer,
                Key: key,
                ContentType: "audio/mpeg",
              }),
            );
          }

          return res.status(HttpStatusCode.Success).json({ hash });
        }

        case "font": {
          const file = fontFileValidator.parse(req.file);
          const ext = fontExtFromFile(file);
          const hash = generateHash(file.buffer, false);
          const key = profileFontKey(user.id, hash, ext);

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
                Body: file.buffer,
                Key: key,
                ContentType: FONT_CONTENT_TYPES[ext],
              }),
            );
          }

          const displayName = file.originalname
            .replace(/\.(woff2|woff|ttf|otf)$/i, "")
            .trim();

          return res.status(HttpStatusCode.Success).json({
            hash,
            fontFamily: `font:${hash}.${ext}`,
            displayName: displayName || "Custom font",
          });
        }

        case "banner":
        case "background":
        case "image": {
          const file = imageFileValidator.parse({
            ...req.file,
            mimetype:
              req.file.mimetype === "image/jpg"
                ? "image/jpeg"
                : req.file.mimetype,
          });

          const isGif = file.mimetype === "image/gif";
          let buffer: Buffer | Uint8Array = file.buffer;

          if (!isGif) {
            buffer = await sharp(buffer).png().toBuffer();
          }

          const hash = await ensureProfileImage(user.id, buffer, isGif);

          return res.status(HttpStatusCode.Success).json({ hash });
        }
      }
    } catch (err) {
      next(err);
    }
  }
}
