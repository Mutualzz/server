import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { assertUserVisible, resolveUserIdentifier } from "@mutualzz/util";
import { validateUserGet } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";

export default class UsersController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { identifier } = validateUserGet.parse(req.params);

      const user = await resolveUserIdentifier(identifier);

      if (!user)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (req.user?.id && req.user.id !== user.id)
        await assertUserVisible(req.user.id, user.id);

      return res.status(HttpStatusCode.Success).json(user);
    } catch (err) {
      next(err);
    }
  }
}
