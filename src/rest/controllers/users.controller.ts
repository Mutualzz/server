import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { resolveUserIdentifier } from "@mutualzz/util";
import { validateUserGet } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";

export default class UsersController {
    static async get(req: Request, res: Response, next: NextFunction) {
        try {
            const { identifier } = validateUserGet.parse(req.params);

            const user = await resolveUserIdentifier(identifier);

            if (!user)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            return res.status(HttpStatusCode.Success).json(user);
        } catch (err) {
            next(err);
        }
    }
}
