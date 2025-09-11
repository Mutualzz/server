import { UserModel } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";

export default class PreviousAvatarController {
    static async deletePreviousAvatar(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const user = await UserModel.findById(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            if (!user.previousAvatars.includes(req.query.avatar as string))
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Avatar not found",
                );

            user.previousAvatars = user.previousAvatars.filter(
                (avatar) => avatar !== req.query.avatar,
            );

            user.markModified("previousAvatars");
            await user.save();

            res.status(HttpStatusCode.Success).json({
                avatar: req.query.avatar as string,
            });
        } catch (error) {
            next(error);
        }
    }
}
