import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { assertUserVisible, resolveUserIdentifier } from "@mutualzz/util";
import { listRecentActivities } from "@mutualzz/util/ActivityHistory.ts";
import { validateUserGet } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import { assertCanViewUserProfile, canViewerDmTarget } from "@mutualzz/util/privacy.ts";

export default class UsersController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { identifier } = validateUserGet.parse(req.params);

      const user = await resolveUserIdentifier(identifier);

      if (!user)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const viewerId = req.user?.id;

      if (viewerId && String(viewerId) !== String(user.id)) {
        await assertUserVisible(viewerId, user.id);
      }

      await assertCanViewUserProfile(viewerId, user.id);

      const viewerCanDm = viewerId
        ? await canViewerDmTarget(viewerId, user.id)
        : undefined;

      return res.status(HttpStatusCode.Success).json({
        ...user,
        ...(viewerCanDm === undefined ? {} : { viewerCanDm }),
      });
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

      const viewerId = req.user?.id;

      if (viewerId && String(viewerId) !== String(target.id)) {
        await assertUserVisible(viewerId, target.id);
      }

      await assertCanViewUserProfile(viewerId, target.id);

      res.json({
        activities: await listRecentActivities(target.id, req.user?.id),
      });
    } catch (err) {
      next(err);
    }
  }
}
