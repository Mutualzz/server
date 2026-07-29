import { setCache } from "@mutualzz/cache";
import {
  db,
  toPublicUser,
  userProfilesTable,
  userSettingsTable,
  usersTable,
} from "@mutualzz/database";
import type { APIPrivateUser } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  bucketName,
  emitEvent,
  execNormalized,
  fireAndForgetAll,
  generateHash,
  generateSessionId,
  genRandColor,
  redis,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  validateDiscordComplete,
  validateDiscordExchange,
} from "@mutualzz/validators";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import {
  BCRYPT_SALT_ROUNDS,
  createSession,
  generateSessionToken,
} from "../util";
import {
  discordAuthorizeUrl,
  discordAvatarUrl,
  discordBannerUrl,
  exchangeDiscordCode,
  fetchDiscordUser,
  fetchDiscordUserProfile,
  type DiscordUser,
} from "../../util/discordApi.ts";
import { isProfileConfigured } from "../../util/profileAssets.ts";
import { frontendOrigin } from "../../util/connections/shared.ts";

const OAUTH_STATE_TTL = 600;
const PENDING_SIGNUP_TTL = 900;

function discordRedirectUri() {
  return `${frontendOrigin()}/auth/discord/callback`;
}

async function storeOAuthState(client: string, linkUserId: string | null) {
  const state = crypto.randomBytes(24).toString("hex");
  await redis.set(
    `discord:oauth:${state}`,
    JSON.stringify({ link: linkUserId, client }),
    "EX",
    OAUTH_STATE_TTL,
  );
  return state;
}

type DiscordOAuthResult =
  | { result: "token"; token: string; client: string }
  | { result: "pending"; pendingId: string; client: string }
  | { result: "linked"; client: string }
  | { result: "error"; error: string; client: string; email?: string };

async function processOAuthCallback(
  code: string,
  state: string,
): Promise<DiscordOAuthResult> {
  const rawState = await redis.get(`discord:oauth:${state}`);
  if (!rawState) {
    throw new HttpException(HttpStatusCode.BadRequest, "OAuth state expired");
  }

  await redis.del(`discord:oauth:${state}`);
  const parsed = JSON.parse(rawState) as {
    link: string | null;
    client: string;
  };

  const tokens = await exchangeDiscordCode(code, discordRedirectUri());
  const discordUser = await fetchDiscordUser(tokens.access_token);
  const profile = await fetchDiscordUserProfile(tokens.access_token);
  const discordId = BigInt(discordUser.id);

  const existingByDiscord = await db.query.usersTable.findFirst({
    where: eq(usersTable.discordId, discordId),
  });

  if (parsed.link) {
    if (existingByDiscord && existingByDiscord.id !== BigInt(parsed.link)) {
      throw new HttpException(
        HttpStatusCode.Conflict,
        "This Discord account is already linked to another user",
      );
    }

    await db
      .update(usersTable)
      .set({ discordId })
      .where(eq(usersTable.id, BigInt(parsed.link)));

    await importDiscordProfile(parsed.link, discordUser, profile.bio ?? null);
    await refreshLinkedUserState(parsed.link);

    return { result: "linked", client: parsed.client };
  }

  if (existingByDiscord) {
    await importDiscordProfile(
      existingByDiscord.id.toString(),
      discordUser,
      profile.bio ?? null,
    );

    const token = generateSessionToken(existingByDiscord.id.toString());
    const sessionId = generateSessionId();
    await createSession(token, existingByDiscord.id.toString(), sessionId);

    return { result: "token", token, client: parsed.client };
  }

  if (discordUser.email) {
    const existingByEmail = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, discordUser.email),
    });

    if (existingByEmail) {
      return {
        result: "error",
        error: "email_exists",
        email: discordUser.email,
        client: parsed.client,
      };
    }
  }

  const pendingId = crypto.randomBytes(16).toString("hex");
  await redis.set(
    `discord:pending:${pendingId}`,
    JSON.stringify({
      discordUser,
      bio: profile.bio ?? null,
      client: parsed.client,
    }),
    "EX",
    PENDING_SIGNUP_TTL,
  );

  return { result: "pending", pendingId, client: parsed.client };
}

async function uploadDiscordImage(
  userId: string,
  url: string,
  folder: "avatars" | "banners",
) {
  const res = await fetch(url);
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const isGif = url.includes(".gif");
  let body: Buffer | Uint8Array = buffer;
  const ext = isGif ? "gif" : "png";
  const contentType = isGif ? "image/gif" : "image/png";

  if (!isGif && folder === "avatars") {
    body = await sharp(buffer).png().toBuffer();
  }

  const hash = generateHash(body, isGif);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Body: body,
      Key: `${folder}/${userId}/${hash}.${ext}`,
      ContentType: contentType,
    }),
  );

  return isGif ? `a_${hash}` : hash;
}

async function refreshLinkedUserState(userId: string) {
  const updatedUser = await execNormalized<APIPrivateUser | null>(
    db.query.usersTable.findFirst({
      columns: { hash: false },
      where: eq(usersTable.id, BigInt(userId)),
    }),
  );

  if (!updatedUser) return;

  const publicUser = toPublicUser(updatedUser);

  fireAndForgetAll([
    {
      label: "event:UserUpdate",
      run: () =>
        emitEvent({
          event: "UserUpdate",
          user_id: userId,
          data: publicUser,
        }),
      meta: { userId },
    },
    {
      label: "cache:update:user",
      run: () => setCache("user", userId, publicUser),
      meta: { userId },
    },
    {
      label: "cache:update:authUser",
      run: () => setCache("authUser", userId, updatedUser),
      meta: { userId },
    },
  ]);
}

async function importDiscordProfile(
  userId: string,
  discordUser: DiscordUser,
  bio: string | null,
) {
  const existing = await execNormalized<
    typeof userProfilesTable.$inferSelect | null
  >(
    db.query.userProfilesTable.findFirst({
      where: eq(userProfilesTable.userId, BigInt(userId)),
    }),
  );

  const existingUser = await execNormalized<
    typeof usersTable.$inferSelect | null
  >(
    db.query.usersTable.findFirst({
      where: eq(usersTable.id, BigInt(userId)),
    }),
  );

  const avatarUrl = discordAvatarUrl(discordUser);
  const bannerUrl = discordBannerUrl(discordUser);

  const avatarHash = avatarUrl
    ? await uploadDiscordImage(userId, avatarUrl, "avatars")
    : null;
  const bannerHash = bannerUrl
    ? await uploadDiscordImage(userId, bannerUrl, "banners")
    : null;

  if (avatarHash) {
    await db
      .update(usersTable)
      .set({ avatar: avatarHash })
      .where(eq(usersTable.id, BigInt(userId)));
  }

  if (discordUser.accent_color != null) {
    const accent = `#${discordUser.accent_color.toString(16).padStart(6, "0")}`;
    await db
      .update(usersTable)
      .set({ accentColor: accent })
      .where(eq(usersTable.id, BigInt(userId)));
  }

  const discordBio = bio?.trim() || null;
  const nextBio = discordBio ?? existing?.bio ?? null;
  const nextBanner = bannerHash ?? existing?.banner ?? null;
  const blocks = existing?.blocks ?? [];
  const configured = isProfileConfigured({
    blocks,
    backgroundImage: existing?.backgroundImage ?? null,
    backgroundColor: existing?.backgroundColor ?? null,
    banner: nextBanner,
    bio: nextBio,
    pronouns: existingUser?.pronouns ?? null,
    profileMusic: existing?.profileMusic ?? null,
  });

  if (existing) {
    await db
      .update(userProfilesTable)
      .set({
        bio: nextBio,
        banner: nextBanner,
        configured,
      })
      .where(eq(userProfilesTable.userId, BigInt(userId)));
    return;
  }

  await db.insert(userProfilesTable).values({
    userId: BigInt(userId),
    bio: nextBio,
    banner: nextBanner,
    configured,
  });
}

export default class DiscordAuthController {
  static async createStartUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const client = String(req.query.client ?? "web");
      const state = await storeOAuthState(client, null);
      res.json({ url: discordAuthorizeUrl(state, discordRedirectUri()) });
    } catch (error) {
      next(error);
    }
  }

  static async exchange(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, state } = validateDiscordExchange.parse(req.body);
      const result = await processOAuthCallback(code, state);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  static async complete(req: Request, res: Response, next: NextFunction) {
    try {
      const { pendingId, username, dateOfBirth, globalName } =
        validateDiscordComplete.parse(req.body);

      const raw = await redis.get(`discord:pending:${pendingId}`);
      if (!raw) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Signup session expired",
        );
      }

      await redis.del(`discord:pending:${pendingId}`);
      const pending = JSON.parse(raw) as {
        discordUser: DiscordUser;
        bio: string | null;
      };

      const discordUser = pending.discordUser;
      const discordId = BigInt(discordUser.id);

      const taken = await db.query.usersTable.findFirst({
        where: or(
          eq(usersTable.username, username),
          ...(discordUser.email
            ? [eq(usersTable.email, discordUser.email)]
            : []),
          eq(usersTable.discordId, discordId),
        ),
      });

      if (taken) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Account already exists",
        );
      }

      if (!discordUser.email) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Discord account must have a verified email",
        );
      }

      const hash = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        BCRYPT_SALT_ROUNDS,
      );
      const id = BigInt(Snowflake.generate());

      const newUser = await db.transaction(async (tx) => {
        const user = await execNormalized<APIPrivateUser | null>(
          tx
            .insert(usersTable)
            .values({
              id,
              username,
              email: discordUser.email!,
              globalName:
                globalName ?? discordUser.global_name ?? discordUser.username,
              hash,
              accentColor: genRandColor(),
              defaultAvatar: {
                type: crypto.randomInt(0, 5),
                color: null,
              },
              dateOfBirth,
              discordId,
            })
            .returning()
            .then((rows) => (rows.length ? rows[0] : null)),
        );

        if (!user) {
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create account",
          );
        }

        await tx.insert(userSettingsTable).values({ userId: BigInt(user.id) });
        return user;
      });

      await importDiscordProfile(newUser.id, discordUser, pending.bio);

      const token = generateSessionToken(newUser.id);
      const sessionId = generateSessionId();
      await createSession(token, newUser.id, sessionId);

      res.status(HttpStatusCode.Created).json({ token });
    } catch (error) {
      next(error);
    }
  }

  static async createLinkUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }

      const client = String(req.query.client ?? "web");
      const state = await storeOAuthState(client, user.id);

      res.json({ url: discordAuthorizeUrl(state, discordRedirectUri()) });
    } catch (error) {
      next(error);
    }
  }

  static async unlink(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }

      await db
        .update(usersTable)
        .set({ discordId: null })
        .where(eq(usersTable.id, BigInt(user.id)));

      await refreshLinkedUserState(user.id);

      res.status(HttpStatusCode.NoContent).send();
    } catch (error) {
      next(error);
    }
  }
}
