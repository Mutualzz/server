import { deleteCache, getCache, invalidateCache, setCache } from "@mutualzz/cache";
import { db, spacesTable, themesTable } from "@mutualzz/database";
import type { APITheme } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  attachSpaceTheme,
  deleteThemeBackgroundImage,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForget,
  getTheme,
  requireSpacePermissions,
  Snowflake,
  uploadThemeBackgroundImage,
} from "@mutualzz/util";
import {
  imageFileValidator,
  validateSpaceThemeIdParams,
  validateSpaceThemeParams,
  validateThemeCreate,
  validateThemeUpdateBody,
} from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class SpaceThemesController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = validateSpaceThemeParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      const themes = await execNormalizedMany<APITheme>(
        db.query.themesTable.findMany({
          where: eq(themesTable.spaceId, BigInt(spaceId)),
        }),
      );

      res.status(HttpStatusCode.Success).json(themes);
    } catch (error) {
      next(error);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId } = validateSpaceThemeParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      const validatedTheme = validateThemeCreate.parse(req.body);

      const insertedTheme = await execNormalized<APITheme | null>(
        db
          .insert(themesTable)
          .values({
            id: BigInt(Snowflake.generate()),
            ...validatedTheme,
            authorId: BigInt(user.id),
            spaceId: BigInt(spaceId),
          })
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (!insertedTheme)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create theme",
        );

      const newTheme = {
        ...insertedTheme,
        author: user,
        spaceId,
      };

      res.status(HttpStatusCode.Created).json(newTheme);

      fireAndForget(() => setCache("theme", newTheme.id, newTheme));
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId, themeId } = validateSpaceThemeIdParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      let theme = await getTheme(themeId);
      if (!theme || theme.spaceId !== spaceId) {
        theme = await execNormalized<APITheme | null>(
          db.query.themesTable.findFirst({
            where: and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );
      }

      if (!theme || theme.spaceId !== spaceId)
        throw new HttpException(HttpStatusCode.NotFound, "Theme not found");

      const validatedTheme = validateThemeUpdateBody.parse(req.body);
      const updates: Record<string, unknown> = {
        ...validatedTheme,
        updatedAt: new Date(),
      };

      if (validatedTheme.backgroundImage === null && theme.backgroundImage) {
        await deleteThemeBackgroundImage(themeId, theme.backgroundImage);
        updates.backgroundImage = null;
      }

      let updatedTheme = await execNormalized<APITheme | null>(
        db
          .update(themesTable)
          .set(updates)
          .where(
            and(
              eq(themesTable.id, BigInt(theme.id)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (!updatedTheme)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update theme",
        );

      updatedTheme = {
        ...updatedTheme,
        author: theme.author || user,
        spaceId,
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);

      fireAndForget(() => setCache("theme", themeId, updatedTheme), {
        label: "cache:set:theme",
        meta: { themeId },
      });

      const space = await getCache("space", spaceId);
      if (space?.themeId === themeId) {
        const lean = { ...space, themeId };
        void setCache("space", spaceId, lean);
        void invalidateCache("spaceHydrated", spaceId);
        void emitEvent({
          event: "SpaceUpdate",
          space_id: spaceId,
          data: await attachSpaceTheme(lean),
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId, themeId } = validateSpaceThemeIdParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      let theme = await getTheme(themeId);
      if (!theme || theme.spaceId !== spaceId) {
        theme = await execNormalized<APITheme | null>(
          db.query.themesTable.findFirst({
            where: and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );
      }

      if (!theme || theme.spaceId !== spaceId)
        throw new HttpException(HttpStatusCode.NotFound, "Theme not found");

      if (theme.backgroundImage) {
        await deleteThemeBackgroundImage(themeId, theme.backgroundImage);
      }

      await db
        .delete(themesTable)
        .where(
          and(
            eq(themesTable.id, BigInt(themeId)),
            eq(themesTable.spaceId, BigInt(spaceId)),
          ),
        );

      const cleared = await execNormalized(
        db
          .update(spacesTable)
          .set({ themeId: null })
          .where(
            and(
              eq(spacesTable.id, BigInt(spaceId)),
              eq(spacesTable.themeId, themeId),
            ),
          )
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (cleared) {
        const payload = { ...cleared, theme: null };
        void setCache("space", spaceId, cleared);
        void invalidateCache("spaceHydrated", spaceId);
        void emitEvent({
          event: "SpaceUpdate",
          space_id: spaceId,
          data: payload,
        });
      }

      res.status(HttpStatusCode.Success).send({
        id: theme.id,
      });

      fireAndForget(() => deleteCache("theme", themeId), {
        label: "cache:delete:theme",
        meta: { themeId },
      });
    } catch (error) {
      next(error);
    }
  }

  static async putBackground(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { spaceId, themeId } = validateSpaceThemeIdParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      let theme = await getTheme(themeId);
      if (!theme || theme.spaceId !== spaceId) {
        theme = await execNormalized<APITheme | null>(
          db.query.themesTable.findFirst({
            where: and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );
      }

      if (!theme || theme.spaceId !== spaceId)
        throw new HttpException(HttpStatusCode.NotFound, "Theme not found");

      if (!req.file)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Background image is required",
        );

      imageFileValidator.parse(req.file);
      const backgroundImage = await uploadThemeBackgroundImage(
        themeId,
        req.file,
        theme.backgroundImage,
      );

      let updatedTheme = await execNormalized<APITheme | null>(
        db
          .update(themesTable)
          .set({ backgroundImage, updatedAt: new Date() })
          .where(
            and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (!updatedTheme)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update theme",
        );

      updatedTheme = {
        ...updatedTheme,
        author: theme.author || user,
        spaceId,
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);
      fireAndForget(() => setCache("theme", themeId, updatedTheme));

      const space = await getCache("space", spaceId);
      if (space?.themeId === themeId) {
        const lean = { ...space, themeId };
        void setCache("space", spaceId, lean);
        void invalidateCache("spaceHydrated", spaceId);
        void emitEvent({
          event: "SpaceUpdate",
          space_id: spaceId,
          data: await attachSpaceTheme(lean),
        });
      }
    } catch (error) {
      next(error);
    }
  }

  static async deleteBackground(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { user } = req;
      const { spaceId, themeId } = validateSpaceThemeIdParams.parse(req.params);

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      let theme = await getTheme(themeId);
      if (!theme || theme.spaceId !== spaceId) {
        theme = await execNormalized<APITheme | null>(
          db.query.themesTable.findFirst({
            where: and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );
      }

      if (!theme || theme.spaceId !== spaceId)
        throw new HttpException(HttpStatusCode.NotFound, "Theme not found");

      if (theme.backgroundImage) {
        await deleteThemeBackgroundImage(themeId, theme.backgroundImage);
      }

      let updatedTheme = await execNormalized<APITheme | null>(
        db
          .update(themesTable)
          .set({ backgroundImage: null, updatedAt: new Date() })
          .where(
            and(
              eq(themesTable.id, BigInt(themeId)),
              eq(themesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .returning()
          .then((rows) => (rows.length ? rows[0] : null)),
      );

      if (!updatedTheme)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update theme",
        );

      updatedTheme = {
        ...updatedTheme,
        author: theme.author || user,
        spaceId,
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);
      fireAndForget(() => setCache("theme", themeId, updatedTheme));

      const space = await getCache("space", spaceId);
      if (space?.themeId === themeId) {
        const lean = { ...space, themeId };
        void setCache("space", spaceId, lean);
        void invalidateCache("spaceHydrated", spaceId);
        void emitEvent({
          event: "SpaceUpdate",
          space_id: spaceId,
          data: await attachSpaceTheme(lean),
        });
      }
    } catch (error) {
      next(error);
    }
  }
}
