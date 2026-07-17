import { deleteCache, getCache, setCache } from "@mutualzz/cache";
import { db, themesTable } from "@mutualzz/database";
import type { APITheme } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  deleteThemeBackgroundImage,
  execNormalized,
  fireAndForget,
  getTheme,
  Snowflake,
  uploadThemeBackgroundImage,
} from "@mutualzz/util";
import {
  imageFileValidator,
  validateThemeCreate,
  validateThemeUpdateBody,
  validateThemeUpdateQuery,
} from "@mutualzz/validators";
import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

async function loadPersonalTheme(themeId: string, userId: string) {
  let theme = await getTheme(themeId);
  if (!theme)
    theme = await execNormalized<APITheme | null>(
      db.query.themesTable.findFirst({
        where: and(
          eq(themesTable.id, BigInt(themeId)),
          isNull(themesTable.spaceId),
        ),
      }),
    );

  if (!theme || theme.spaceId)
    throw new HttpException(HttpStatusCode.NotFound, "Theme not found");

  if (theme.authorId && BigInt(theme.authorId) !== BigInt(userId))
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "You are not allowed to update this theme",
    );

  return theme;
}

export default class MeThemesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const validatedTheme = validateThemeCreate.parse(req.body);

      const insertedTheme = await execNormalized<APITheme | null>(
        db
          .insert(themesTable)
          .values({
            id: BigInt(Snowflake.generate()),
            ...validatedTheme,
            authorId: BigInt(user.id),
            spaceId: null,
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
      const { themeId } = validateThemeUpdateQuery.parse(req.params);
      const theme = await loadPersonalTheme(themeId, user.id);
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
          .where(eq(themesTable.id, BigInt(theme.id)))
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
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);

      fireAndForget(() => setCache("theme", themeId, updatedTheme), {
        label: "cache:set:theme",
        meta: { themeId },
      });
    } catch (error) {
      next(error);
    }
  }

  static async putBackground(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { themeId } = validateThemeUpdateQuery.parse(req.params);
      const theme = await loadPersonalTheme(themeId, user.id);

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
          .where(eq(themesTable.id, BigInt(themeId)))
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
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);
      fireAndForget(() => setCache("theme", themeId, updatedTheme));
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
      const { themeId } = validateThemeUpdateQuery.parse(req.params);
      const theme = await loadPersonalTheme(themeId, user.id);

      if (theme.backgroundImage) {
        await deleteThemeBackgroundImage(themeId, theme.backgroundImage);
      }

      let updatedTheme = await execNormalized<APITheme | null>(
        db
          .update(themesTable)
          .set({ backgroundImage: null, updatedAt: new Date() })
          .where(eq(themesTable.id, BigInt(themeId)))
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
      };

      res.status(HttpStatusCode.Success).json(updatedTheme);
      fireAndForget(() => setCache("theme", themeId, updatedTheme));
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { themeId } = validateThemeUpdateQuery.parse(req.params);
      const theme = await loadPersonalTheme(themeId, user.id);

      if (!theme.authorId)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Woah there! You can't delete an official theme",
        );

      if (theme.backgroundImage) {
        await deleteThemeBackgroundImage(themeId, theme.backgroundImage);
      }

      await db.delete(themesTable).where(eq(themesTable.id, BigInt(themeId)));

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
}
