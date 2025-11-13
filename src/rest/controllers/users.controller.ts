import { db, toPublicUser, usersTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { getUser } from "@mutualzz/util";
import { validateUserGet } from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class UsersController {
    static async get(req: Request, res: Response, next: NextFunction) {
        try {
            const auth = await getUser(req.user?.id);
            if (!auth)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { id } = validateUserGet.parse(req.params);

            const user = await db
                .select()
                .from(usersTable)
                .where(eq(usersTable.id, id))
                .then((results) => results[0]);

            if (!user)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            return res.status(HttpStatusCode.Success).json(toPublicUser(user));
        } catch (err) {
            next(err);
        }
    }
}
