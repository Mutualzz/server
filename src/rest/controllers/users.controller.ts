import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { assertUserVisible, resolveUserIdentifier } from "@mutualzz/util";
import { listRecentActivities } from "@mutualzz/util/ActivityHistory.ts";
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

  static async getRecentActivities(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const identifierRaw = req.params.identifier;
      const identifier = Array.isArray(identifierRaw)
        ? identifierRaw[0]
        : identifierRaw;
      if (!identifier) {
        throw new HttpException(HttpStatusCode.BadRequest, "Missing user");
      }

      const target = await resolveUserIdentifier(identifier);
      if (!target) {
        throw new HttpException(HttpStatusCode.NotFound, "User not found");
      }

      if (req.user?.id && req.user.id !== target.id) {
        await assertUserVisible(req.user.id, target.id);
      }

      res.json({
        activities: await listRecentActivities(target.id, req.user?.id),
      });
    } catch (err) {
      next(err);
    }
  }
}
