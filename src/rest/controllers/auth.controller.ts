import { db, userSettingsTable, usersTable } from "@mutualzz/database";
import { defaultAvatars, HttpException, HttpStatusCode } from "@mutualzz/types";
import { generateSessionId, genRandColor, genSnowflake } from "@mutualzz/util";
import { validateLogin, validateRegister } from "@mutualzz/validators";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { eq, or } from "drizzle-orm";
import { type NextFunction, type Request, type Response } from "express";
import {
    BCRYPT_SALT_ROUNDS,
    createSession,
    generateSessionToken,
} from "../utils";

export default class AuthController {
    static async register(req: Request, res: Response, next: NextFunction) {
        try {
            // Destructure and validate request body
            const { username, email, password, globalName, dateOfBirth } =
                validateRegister.parse(req.body);

            const userExists = await db
                .select()
                .from(usersTable)
                .where(
                    or(
                        eq(usersTable.username, username),
                        eq(usersTable.email, email),
                    ),
                )
                .then((results) => results[0]);

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

            const defaultAvatar =
                defaultAvatars[crypto.randomInt(0, defaultAvatars.length)];

            const accentColor = genRandColor();

            const id = genSnowflake();
            const newUser = await db.transaction(async (tx) => {
                const user = await tx
                    .insert(usersTable)
                    .values({
                        id,
                        username,
                        email,
                        globalName,
                        hash,
                        accentColor,
                        defaultAvatar,
                        dateOfBirth,
                    })
                    .returning()
                    .then((results) => results[0]);

                if (!user)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to register, please try again later",
                    );

                await tx.insert(userSettingsTable).values({
                    user: id,
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
            if (username)
                whereConditions.push(eq(usersTable.username, username));
            if (email) whereConditions.push(eq(usersTable.email, email));

            if (whereConditions.length === 0) {
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Username or email is required",
                );
            }

            const user = await db
                .select({
                    id: usersTable.id,
                    hash: usersTable.hash,
                })
                .from(usersTable)
                .where(or(...whereConditions))
                .then((results) => results[0]);

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
            const pass = bcrypt.compare(password, user.hash);

            // If password is invalid, throw an error
            if (!pass)
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

            await db.transaction(async (tx) => {
                const existingSettings = await tx
                    .select()
                    .from(userSettingsTable)
                    .where(eq(userSettingsTable.user, user.id))
                    .then((results) => results[0]);

                if (!existingSettings) {
                    await tx.insert(userSettingsTable).values({
                        user: user.id,
                    });
                }
            });

            const token = generateSessionToken(user.id);
            const sessionId = generateSessionId();
            await createSession(token, user.id, sessionId);

            // Respond with success and token and user data
            res.status(HttpStatusCode.Success).json({
                token,
            });
        } catch (error) {
            next(error);
        }
    }
}
