import { db, appealsTable } from "@mutualzz/database";
import type { APIAppeal } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  execNormalizedMany,
  liftSpaceLockdown,
  requireStaff,
} from "@mutualzz/util";
import {
  validateStaffAppealParams,
  validateStaffAppealsQuery,
  validateStaffAppealUpdateBody,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const appealUserColumns = {
  id: true,
  username: true,
  globalName: true,
  avatar: true,
} as const;

const appealSpaceColumns = {
  id: true,
  name: true,
  icon: true,
} as const;

export default class StaffAppealsController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { status, before, limit } = validateStaffAppealsQuery.parse(
        req.query,
      );

      const conditions = [];
      if (status) conditions.push(eq(appealsTable.status, status));
      if (before) conditions.push(lt(appealsTable.id, BigInt(before)));

      const appeals = await execNormalizedMany<APIAppeal>(
        db.query.appealsTable.findMany({
          where: conditions.length ? and(...conditions) : undefined,
          orderBy: desc(appealsTable.createdAt),
          limit,
          with: {
            user: { columns: appealUserColumns },
            space: { columns: appealSpaceColumns },
            reviewedBy: { columns: appealUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(appeals);
    } catch (err) {
      next(err);
    }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { appealId } = validateStaffAppealParams.parse(req.params);
      const { status, staffResponse } = validateStaffAppealUpdateBody.parse(
        req.body,
      );

      const appeal = await db.query.appealsTable.findFirst({
        where: eq(appealsTable.id, BigInt(appealId)),
      });

      if (!appeal)
        throw new HttpException(HttpStatusCode.NotFound, "Appeal not found");

      if (appeal.status !== "pending")
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Appeal has already been reviewed",
        );

      await db
        .update(appealsTable)
        .set({
          status,
          staffResponse: staffResponse ?? null,
          reviewedById: BigInt(actor.id),
          reviewedAt: new Date(),
        })
        .where(eq(appealsTable.id, BigInt(appealId)));

      if (status === "accepted" && appeal.spaceId) {
        await liftSpaceLockdown(
          appeal.spaceId.toString(),
          actor.id,
          `Appeal ${appealId} accepted`,
        );
      }

      if (status === "accepted" && !appeal.spaceId) {
        // Account appeals are reviewed manually in the staff user panel.
      }

      const [updated] = await execNormalizedMany<APIAppeal>(
        db.query.appealsTable.findMany({
          where: eq(appealsTable.id, BigInt(appealId)),
          limit: 1,
          with: {
            user: { columns: appealUserColumns },
            space: { columns: appealSpaceColumns },
            reviewedBy: { columns: appealUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }
}
