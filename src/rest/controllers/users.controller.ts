import { UserModel } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";

export default class UsersController {
    static async getUser(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = req.params;

            const user = await UserModel.findById(id);

            if (!user)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            return res.status(HttpStatusCode.Success).json(user.toPublicUser());
        } catch (err) {
            next(err);
        }
    }
}
