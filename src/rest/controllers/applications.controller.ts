import { applicationsTable, db } from "@mutualzz/database";
import type { APIApplication, APIPublicApplication } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  deleteApplicationIcon,
  execNormalized,
  execNormalizedMany,
  Snowflake,
  uploadApplicationIcon,
} from "@mutualzz/util";
import {
  MAX_APPLICATIONS_PER_USER,
  validateApplicationCreate,
  validateApplicationParams,
  validateApplicationUpdate,
} from "@mutualzz/validators";
import { desc, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

function requireUser(req: Request) {
  if (!req.user)
    throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
  return req.user;
}

async function findApplication(applicationId: string) {
  return execNormalized<APIApplication | null>(
    db.query.applicationsTable.findFirst({
      where: eq(applicationsTable.id, BigInt(applicationId)),
    }),
  );
}

async function loadOwnedApplication(applicationId: string, userId: string) {
  const application = await findApplication(applicationId);

  // Same 404 for "missing" and "not yours", so IDs can't be probed for owners
  if (!application || BigInt(application.ownerId) !== BigInt(userId))
    throw new HttpException(HttpStatusCode.NotFound, "Application not found");

  return application;
}

async function updateApplication(
  applicationId: string,
  values: Partial<typeof applicationsTable.$inferInsert>,
) {
  const updated = await execNormalized<APIApplication | null>(
    db
      .update(applicationsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(applicationsTable.id, BigInt(applicationId)))
      .returning()
      .then((rows) => (rows.length ? rows[0] : null)),
  );

  if (!updated)
    throw new HttpException(
      HttpStatusCode.InternalServerError,
      "Failed to update application",
    );

  return updated;
}

export default class ApplicationsController {
  static async listMine(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);

      const applications = await execNormalizedMany<APIApplication>(
        db.query.applicationsTable.findMany({
          where: eq(applicationsTable.ownerId, BigInt(user.id)),
          orderBy: desc(applicationsTable.createdAt),
        }),
      );

      res.status(HttpStatusCode.Success).json(applications);
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);
      const { name, description } = validateApplicationCreate.parse(req.body);

      const count = await db.$count(
        applicationsTable,
        eq(applicationsTable.ownerId, BigInt(user.id)),
      );
      if (count >= MAX_APPLICATIONS_PER_USER)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          `You can have at most ${MAX_APPLICATIONS_PER_USER} applications`,
        );

      const application = await execNormalized<APIApplication | null>(
        db
          .insert(applicationsTable)
          .values({
            id: BigInt(Snowflake.generate()),
            name,
            description: description || null,
            ownerId: BigInt(user.id),
          })
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (!application)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create application",
        );

      res.status(HttpStatusCode.Created).json(application);
    } catch (error) {
      next(error);
    }
  }

  // Public: clients resolve the name/icon of whatever app ID shows up in a presence
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { applicationId } = validateApplicationParams.parse(req.params);
      const application = await findApplication(applicationId);

      if (!application)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Application not found",
        );

      const publicApplication: APIPublicApplication = {
        id: application.id,
        name: application.name,
        icon: application.icon ?? null,
      };

      res.setHeader("Cache-Control", "public, max-age=300");
      res.status(HttpStatusCode.Success).json(publicApplication);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);
      const { applicationId } = validateApplicationParams.parse(req.params);
      await loadOwnedApplication(applicationId, user.id);
      const { name, description } = validateApplicationUpdate.parse(req.body);

      const updated = await updateApplication(applicationId, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined
          ? { description: description || null }
          : {}),
      });

      res.status(HttpStatusCode.Success).json(updated);
    } catch (error) {
      next(error);
    }
  }

  static async putIcon(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);
      const { applicationId } = validateApplicationParams.parse(req.params);
      const application = await loadOwnedApplication(applicationId, user.id);

      if (!req.file)
        throw new HttpException(HttpStatusCode.BadRequest, "Icon is required");

      const icon = await uploadApplicationIcon(
        applicationId,
        req.file,
        application.icon,
      );

      const updated = await updateApplication(applicationId, { icon });

      res.status(HttpStatusCode.Success).json(updated);
    } catch (error) {
      next(error);
    }
  }

  static async deleteIcon(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);
      const { applicationId } = validateApplicationParams.parse(req.params);
      const application = await loadOwnedApplication(applicationId, user.id);

      if (application.icon)
        await deleteApplicationIcon(applicationId, application.icon);

      const updated = await updateApplication(applicationId, { icon: null });

      res.status(HttpStatusCode.Success).json(updated);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req);
      const { applicationId } = validateApplicationParams.parse(req.params);
      const application = await loadOwnedApplication(applicationId, user.id);

      if (application.icon)
        await deleteApplicationIcon(applicationId, application.icon);

      await db
        .delete(applicationsTable)
        .where(eq(applicationsTable.id, BigInt(applicationId)));

      res.status(HttpStatusCode.Success).json({ id: application.id });
    } catch (error) {
      next(error);
    }
  }
}
