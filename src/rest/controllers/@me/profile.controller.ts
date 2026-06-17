import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { db, userProfilesTable } from "@mutualzz/database";
import type { APIProfileIntroMusic, APIUserProfile } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  buildEmbed,
  bucketName,
  lookupDeezerTrack,
  lookupItunesTrack,
  emitEvent,
  execNormalized,
  fireAndForget,
  generateHash,
  resolveUserIdentifier,
  s3Client,
  searchDeezerTracks,
  searchItunesTracks,
  toDeezerMusicSearchTrack,
  toIntroMusicFromDeezerTrack,
  toIntroMusicFromItunesTrack,
  toMusicSearchTrack,
} from "@mutualzz/util";
import {
  imageFileValidator,
  profileMusicFileValidator,
  validateProfileAssetUpload,
  validateProfileGet,
  validateProfileMusicSearch,
  validateProfileUpdate,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";

const toAPIUserProfile = (
  row: typeof userProfilesTable.$inferSelect,
): APIUserProfile => ({
  userId: row.userId.toString(),
  configured: row.configured,
  backgroundColor: row.backgroundColor,
  backgroundImage: row.backgroundImage,
  banner: row.banner,
  bio: row.bio,
  introMusic: row.introMusic,
  blocks: row.blocks,
  updatedAt: row.updatedAt,
});

const emptyProfile = (userId: string): APIUserProfile => ({
  userId,
  configured: false,
  backgroundColor: null,
  backgroundImage: null,
  banner: null,
  bio: null,
  introMusic: null,
  blocks: [],
  updatedAt: new Date(),
});

const isConfigured = (profile: {
  blocks: unknown[];
  backgroundImage?: string | null;
  backgroundColor?: string | null;
  banner?: string | null;
  bio?: string | null;
  introMusic?: APIProfileIntroMusic | null;
}) =>
  profile.blocks.length > 0 ||
  !!profile.backgroundImage ||
  !!profile.backgroundColor ||
  !!profile.banner ||
  !!profile.bio ||
  !!profile.introMusic;

const resolveIntroMusic = async (input: {
  introMusicUrl?: string | null;
  introMusicTrackId?: string | null;
  introMusicTrackSource?: "itunes" | "deezer" | null;
}): Promise<APIProfileIntroMusic | null> => {
  if (input.introMusicTrackId) {
    const source = input.introMusicTrackSource ?? "itunes";

    if (source === "deezer") {
      const track = await lookupDeezerTrack(input.introMusicTrackId);
      if (!track) {
        throw new HttpException(HttpStatusCode.BadRequest, "Track not found");
      }
      return toIntroMusicFromDeezerTrack(track);
    }

    const track = await lookupItunesTrack(input.introMusicTrackId).catch(
      () => null,
    );
    if (!track)
      throw new HttpException(HttpStatusCode.BadRequest, "Track not found");

    return toIntroMusicFromItunesTrack(track);
  }

  const ref = input.introMusicUrl;
  if (!ref) return null;

  if (/^[a-f0-9_]+$/i.test(ref)) {
    return {
      url: ref,
      audioHash: ref,
      title: "Intro music",
    };
  }

  const embed = await buildEmbed(ref);
  if (!embed?.spotify && !embed?.youtube && !embed?.apple) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Intro music must be a searched track, MP3 upload, or YouTube / Apple Music link",
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
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { identifier } = validateProfileGet.parse(req.params);

      const user = await resolveUserIdentifier(identifier);
      if (!user) {
        throw new HttpException(HttpStatusCode.NotFound, "User not found");
      }

      const userId = user.id;

      const profile = await execNormalized<
        typeof userProfilesTable.$inferSelect | null
      >(
        db.query.userProfilesTable.findFirst({
          where: eq(userProfilesTable.userId, BigInt(userId)),
        }),
      );

      if (!profile) {
        return res.status(HttpStatusCode.Success).json(emptyProfile(userId));
      }

      return res.status(HttpStatusCode.Success).json(toAPIUserProfile(profile));
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      req.params.identifier = req.user.id;
      return ProfileController.get(req, res, next);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const body = validateProfileUpdate.parse(req.body);

      const introMusic = await resolveIntroMusic({
        introMusicUrl: body.introMusicUrl,
        introMusicTrackId: body.introMusicTrackId,
        introMusicTrackSource: body.introMusicTrackSource ?? null,
      });

      const payload = {
        backgroundColor: body.backgroundColor ?? null,
        backgroundImage: body.backgroundImage ?? null,
        banner: body.banner ?? null,
        bio: body.bio ?? null,
        introMusic,
        blocks: body.blocks,
        configured: isConfigured({
          blocks: body.blocks,
          backgroundColor: body.backgroundColor ?? null,
          backgroundImage: body.backgroundImage ?? null,
          banner: body.banner ?? null,
          bio: body.bio ?? null,
          introMusic,
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

      const apiProfile = toAPIUserProfile(updated);

      res.status(HttpStatusCode.Success).json(apiProfile);

      fireAndForget(() =>
        emitEvent({
          event: "UserProfileUpdate",
          user_id: user.id,
          data: apiProfile,
        }),
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

  static async uploadAsset(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      if (!req.file) {
        throw new HttpException(HttpStatusCode.BadRequest, "No file uploaded");
      }

      const { type } = validateProfileAssetUpload.parse(req.query);

      if (type === "music") {
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

      const file = imageFileValidator.parse({
        ...req.file,
        mimetype:
          req.file.mimetype === "image/jpg" ? "image/jpeg" : req.file.mimetype,
      });

      const isGif = file.mimetype === "image/gif";
      let buffer: Buffer | Uint8Array = file.buffer;

      if (!isGif) {
        buffer = await sharp(buffer).png().toBuffer();
      }

      const hash = generateHash(buffer, isGif);
      const storedExt = isGif ? "gif" : "png";
      const key =
        type === "banner"
          ? `profiles/${user.id}/banner/${hash}.${storedExt}`
          : `profiles/${user.id}/background/${hash}.${storedExt}`;

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
            Body: buffer,
            Key: key,
            ContentType: isGif ? "image/gif" : "image/png",
          }),
        );
      }

      return res.status(HttpStatusCode.Success).json({ hash });
    } catch (err) {
      next(err);
    }
  }
}
