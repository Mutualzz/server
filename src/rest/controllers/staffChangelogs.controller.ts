import { changelogsTable, db, staffActionsTable } from "@mutualzz/database";
import type { APIChangelog, StaffActionType } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  requireDeveloper,
  Snowflake,
} from "@mutualzz/util";
import {
  validateStaffChangelogParams,
  validateStaffChangelogsQuery,
  validateStaffCreateChangelogBody,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const toApiChangelog = (row: typeof changelogsTable.$inferSelect): APIChangelog => ({
  id: String(row.id),
  title: row.title,
  body: row.body,
  imageUrl: row.imageUrl ?? null,
  authorId: String(row.authorId),
  desktopVersion: row.desktopVersion ?? null,
  mobileVersion: row.mobileVersion ?? null,
  publishedAt: row.publishedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export default class StaffChangelogsController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      requireDeveloper(req.user);

      const { before, limit } = validateStaffChangelogsQuery.parse(req.query);

      const conditions = [];
      if (before) conditions.push(lt(changelogsTable.id, BigInt(before)));

      const rows = await db
        .select()
        .from(changelogsTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(changelogsTable.id))
        .limit(limit);

      res.status(HttpStatusCode.Success).json(rows.map(toApiChangelog));
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireDeveloper(req.user);
      const body = validateStaffCreateChangelogBody.parse(req.body);

      const id = BigInt(Snowflake.generate());

      const [row] = await db
        .insert(changelogsTable)
        .values({
          id,
          title: body.title,
          body: body.body,
          imageUrl: body.imageUrl ?? null,
          authorId: BigInt(actor.id),
          desktopVersion: body.desktopVersion ?? null,
          mobileVersion: body.mobileVersion ?? null,
        })
        .returning();

      if (!row)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create changelog",
        );

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: null,
        action: "changelog.publish" satisfies StaffActionType,
        reason: body.title,
      });

      res.status(HttpStatusCode.Created).json(toApiChangelog(row));
    } catch (err) {
      next(err);
    }
  }

  static async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireDeveloper(req.user);
      const { changelogId } = validateStaffChangelogParams.parse(req.params);

      const existing = await db.query.changelogsTable.findFirst({
        where: eq(changelogsTable.id, BigInt(changelogId)),
      });

      if (!existing)
        throw new HttpException(HttpStatusCode.NotFound, "Changelog not found");

      await db
        .delete(changelogsTable)
        .where(eq(changelogsTable.id, BigInt(changelogId)));

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: null,
        action: "changelog.delete" satisfies StaffActionType,
        reason: existing.title,
      });

      res.status(HttpStatusCode.NoContent).send();
    } catch (err) {
      next(err);
    }
  }
}

export { toApiChangelog };
