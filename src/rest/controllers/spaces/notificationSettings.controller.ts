import {
  computeMutedUntilDuration,
  getSpaceNotificationSettings,
  upsertSpaceNotificationSettings,
} from "@mutualzz/util/notificationSettings.ts";
import { emitEvent, fireAndForgetAll, getMember } from "@mutualzz/util";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { patchSpaceNotificationSettingsSchema } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

const validateSpaceParams = z.object({
  spaceId: z.string(),
});

export default class SpaceNotificationSettingsController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = validateSpaceParams.parse(req.params);

      if (!(await getMember(spaceId, user.id, true))) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a member of this space",
        );
      }

      const settings = await getSpaceNotificationSettings(user.id, spaceId);
      res.status(HttpStatusCode.Success).json(settings);
    } catch (err) {
      next(err);
    }
  }

  static async patch(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = validateSpaceParams.parse(req.params);
      const body = patchSpaceNotificationSettingsSchema.parse(req.body);

      if (!(await getMember(spaceId, user.id, true))) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a member of this space",
        );
      }

      let mutedUntil = body.mutedUntil;
      if (body.muteDuration !== undefined) {
        mutedUntil = computeMutedUntilDuration(body.muteDuration);
      }

      const result = await upsertSpaceNotificationSettings(user.id, spaceId, {
        ...(body.level !== undefined ? { level: body.level } : {}),
        ...(mutedUntil !== undefined ? { mutedUntil } : {}),
        ...(body.suppressEveryone !== undefined
          ? { suppressEveryone: body.suppressEveryone }
          : {}),
        ...(body.suppressRoles !== undefined
          ? { suppressRoles: body.suppressRoles }
          : {}),
      });

      fireAndForgetAll([
        {
          label: "event:SpaceNotificationSettingsUpdate",
          run: () =>
            emitEvent({
              event: "SpaceNotificationSettingsUpdate",
              user_id: user.id,
              data: result,
            }),
        },
      ]);

      res.status(HttpStatusCode.Success).json(result);
    } catch (err) {
      next(err);
    }
  }
}
