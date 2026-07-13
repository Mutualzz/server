import {
  changelogsTable,
  db,
  userSettingsTable,
} from "@mutualzz/database";
import type { APIChangelog } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { semverGte } from "@mutualzz/util";
import {
  validateChangelogParams,
  validateChangelogUnseenQuery,
} from "@mutualzz/validators";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { toApiChangelog } from "./staffChangelogs.controller.ts";

export default class ChangelogsController {
  static async unseen(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      const { platform, version } = validateChangelogUnseenQuery.parse(
        req.query,
      );

      const settings = await db.query.userSettingsTable.findFirst({
        where: eq(userSettingsTable.userId, BigInt(user.id)),
        columns: { lastSeenChangelogId: true },
      });

      const lastSeenId = settings?.lastSeenChangelogId ?? null;

      const platformColumn =
        platform === "desktop"
          ? changelogsTable.desktopVersion
          : changelogsTable.mobileVersion;

      const conditions = [isNotNull(platformColumn)];
      if (lastSeenId != null)
        conditions.push(gt(changelogsTable.id, lastSeenId));

      const candidates = await db
        .select()
        .from(changelogsTable)
        .where(and(...conditions))
        .orderBy(desc(changelogsTable.id))
        .limit(100);

      const eligible = candidates.find((row) => {
        const target =
          platform === "desktop" ? row.desktopVersion : row.mobileVersion;
        return !!target && semverGte(version, target);
      });

      res
        .status(HttpStatusCode.Success)
        .json(eligible ? toApiChangelog(eligible) : null);
    } catch (err) {
      next(err);
    }
  }

  static async ack(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      const { changelogId } = validateChangelogParams.parse(req.params);

      const changelog = await db.query.changelogsTable.findFirst({
        where: eq(changelogsTable.id, BigInt(changelogId)),
      });

      if (!changelog)
        throw new HttpException(HttpStatusCode.NotFound, "Changelog not found");

      const settings = await db.query.userSettingsTable.findFirst({
        where: eq(userSettingsTable.userId, BigInt(user.id)),
        columns: { lastSeenChangelogId: true },
      });

      const current = settings?.lastSeenChangelogId ?? null;
      if (current == null || BigInt(changelogId) > current) {
        await db
          .insert(userSettingsTable)
          .values({
            userId: BigInt(user.id),
            lastSeenChangelogId: BigInt(changelogId),
          })
          .onConflictDoUpdate({
            target: userSettingsTable.userId,
            set: {
              lastSeenChangelogId: BigInt(changelogId),
            },
          });
      }

      res.status(HttpStatusCode.NoContent).send();
    } catch (err) {
      next(err);
    }
  }
}
