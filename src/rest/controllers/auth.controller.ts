import { defaultAvatars, HttpException, HttpStatusCode } from "@mutualzz/types";
import { validateLogin, validateRegister } from "@mutualzz/validators";

import { UserModel } from "@mutualzz/database";
import { generateSessionId, genRandColor, genSnowflake } from "@mutualzz/util";
import bcrypt from "bcrypt";
import crypto from "crypto";
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

            // Check if user already exists
            const userExists = await UserModel.findOne({
                $or: [{ username }, { email }],
            });

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
            const salt = bcrypt.genSaltSync(BCRYPT_SALT_ROUNDS);
            const hash = bcrypt.hashSync(password, salt);

            const defaultAvatar =
                defaultAvatars[crypto.randomInt(0, defaultAvatars.length)];

            const accentColor = genRandColor();

            const newUser = new UserModel({
                _id: genSnowflake(),
                username,
                email,
                globalName,
                password: hash,
                accentColor: `#${accentColor}`,
                defaultAvatar,
                dateOfBirth,
                createdAt: new Date(),
                createdTimestamp: Date.now(),
                updatedAt: new Date(),
                updatedTimestamp: Date.now(),
            });

            await newUser.save();

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

            // Find user by username or email
            const user = await UserModel.findOne({
                $or: [{ username }, { email }],
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
            const pass = bcrypt.compareSync(password, user.password);

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
