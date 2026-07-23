import { BitField, userFlags } from "@mutualzz/bitfield";
import { db, userSettingsTable, usersTable } from "@mutualzz/database";
import type { APIPrivateUser } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { execNormalized, generateSessionId, genRandColor, postmark, redis, Snowflake, } from "@mutualzz/util";
import { validateForgotPassword, validateLogin, validateRegister, validateResetPassword, } from "@mutualzz/validators";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { eq, or } from "drizzle-orm";
import { type NextFunction, type Request, type Response } from "express";
import { BCRYPT_SALT_ROUNDS, createSession, generateSessionToken, revokeAllSessions, revokeSession, } from "../util";

export default class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      // Destructure and validate request body
      const { username, email, password, globalName, dateOfBirth } =
        validateRegister.parse(req.body);

      const userExists = await execNormalized<APIPrivateUser>(
        db.query.usersTable.findFirst({
          where: or(
            eq(usersTable.username, username),
            eq(usersTable.email, email),
          ),
        }),
      );

      // If user exists, throw an error
      if (userExists) {
        if (userExists.username === username)
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Username already exists",
            [
              {
                path: "username",
                message: "Username already exists",
              },
            ],
          );

        if (userExists.email === email)
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Email already exists",
            [{ path: "email", message: "Email already exists" }],
          );
      }

      // Hash password
      const hash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      const defaultAvatar = crypto.randomInt(0, 5);

      const accentColor = genRandColor();

      const id = BigInt(Snowflake.generate());
      const newUser = await db.transaction(async (tx) => {
        const user = await execNormalized<APIPrivateUser | null>(
          tx
            .insert(usersTable)
            .values({
              id,
              username,
              email,
              globalName,
              hash,
              accentColor,
              defaultAvatar: {
                type: defaultAvatar,
                color: null,
              },
              dateOfBirth,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!user)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to register, please try again later",
          );

        await tx
          .insert(userSettingsTable)
          .values({
            userId: BigInt(user.id),
          })
          .onConflictDoUpdate({
            target: userSettingsTable.userId,
            set: { userId: BigInt(user.id) },
          });

        return user;
      });

      const token = generateSessionToken(newUser.id);
      const sessionId = generateSessionId();
      await createSession(token, newUser.id, sessionId);

      // Respond with success
      res.status(HttpStatusCode.Created).json({
        token,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      // Destructure and validate request body
      const { username, email, password } = validateLogin.parse(req.body);

      const whereConditions = [];
      if (username) whereConditions.push(eq(usersTable.username, username));
      if (email) whereConditions.push(eq(usersTable.email, email));

      if (whereConditions.length === 0) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Username or email is required",
        );
      }

      const user = await db.query.usersTable.findFirst({
        columns: {
          id: true,
          hash: true,
          flags: true,
        },
        where: or(...whereConditions),
      });

      // If user does not exist, throw an error
      if (!user)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Invalid credentials",
          [
            {
              path: "password",
              message: "Invalid username or password",
            },
          ],
        );

      // Compare with input password using bcrypt
      const pass = await bcrypt.compare(password, user.hash);

      // If password is invalid, throw an error
      if (!pass)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Invalid username or password",
          [
            {
              path: "password",
              message: "Invalid username or password",
            },
          ],
        );

      const flags = BitField.fromString(userFlags, user.flags.toString());

      if (flags.has("Deleted"))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "This account has been deleted",
        );

      if (flags.has("Disabled"))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "This account has been disabled",
        );

      await db.transaction(async (tx) => {
        const existingSettings = await tx.query.userSettingsTable.findFirst({
          columns: {
            userId: true,
          },
          where: eq(userSettingsTable.userId, BigInt(user.id)),
        });

        if (!existingSettings) {
          await tx.insert(userSettingsTable).values({
            userId: BigInt(user.id),
          });
        }
      });

      const token = generateSessionToken(user.id.toString());
      const sessionId = generateSessionId();
      await createSession(token, user.id, sessionId);

      // Respond with success and token and user data
      res.status(HttpStatusCode.Success).json({
        token,
        userId: user.id,
      });
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (token) await revokeSession(token);

      res.status(HttpStatusCode.Success).json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  static async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { username, email } = validateForgotPassword.parse(req.body);

      const whereConditions = [];
      if (username) whereConditions.push(eq(usersTable.username, username));
      if (email) whereConditions.push(eq(usersTable.email, email));

      const user = await execNormalized<APIPrivateUser>(
        db.query.usersTable.findFirst({
          columns: {
            id: true,
            email: true,
          },
          where: or(...whereConditions),
        }),
      );

      if (!user)
        throw new HttpException(HttpStatusCode.NotFound, "User does not exist");

      const cooldownKey = `passwordResetCooldown:${user.id}`;
      const onCooldown = await redis.get(cooldownKey);

      if (onCooldown) {
        res.status(HttpStatusCode.Success).json({
          success: true,
        });

        return;
      }

      const token = crypto.randomBytes(32).toString("hex");
      const redisKey = `passwordReset:${token}`;

      await redis.set(redisKey, user.id, "EX", 1800);
      await redis.set(cooldownKey, "1", "EX", 60);

      const resetDomain =
        process.env.NODE_ENV === "development"
          ? process.env.FRONTEND_URL
          : "https://mutualzz.com";
      const resetLink = `${resetDomain}/reset?token=${token}`;

      const sentEmail = await postmark.sendEmailWithTemplate({
        From: "reset@mutualzz.com",
        To: user.email,
        MessageStream: "forgot-password",
        TemplateAlias: "forgot-password",
        TemplateModel: {
          resetUrl: resetLink,
          email: user.email,
        },
      });

      if (sentEmail.ErrorCode !== 0)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to send verification email",
        );

      res.status(HttpStatusCode.Success).json({
        success: true,
      });
    } catch (err) {
      next(err);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, password } = validateResetPassword.parse(req.body);

      const redisKey = `passwordReset:${token}`;
      const userId = await redis.get(redisKey);

      if (!userId)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Reset link is invalid or has expired",
        );

      await redis.del(redisKey);

      const newHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      const updatedUser = await db
        .update(usersTable)
        .set({ hash: newHash })
        .where(eq(usersTable.id, BigInt(userId)))
        .returning()
        .then((res) => (res.length ? res[0] : null));

      if (!updatedUser)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user password",
        );

      await revokeAllSessions(userId);

      res.status(HttpStatusCode.Success).json({
        success: true,
      });
    } catch (err) {
      next(err);
    }
  }

}
