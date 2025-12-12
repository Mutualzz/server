import { deleteCache, getCache, setCache } from "@mutualzz/cache";
import { db, themesTable } from "@mutualzz/database";
import type { APITheme } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { execNormalized, Snowflake } from "@mutualzz/util";
import {
    validateThemePatchBody,
    validateThemePatchQuery,
    validateThemePut,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class MeThemesController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const validatedTheme = validateThemePut.parse(req.body);

            const newTheme = await execNormalized<APITheme>(
                db
                    .insert(themesTable)
                    .values({
                        id: BigInt(Snowflake.generate()),
                        ...validatedTheme,
                        authorId: BigInt(user.id),
                    })
                    .returning()
                    .then((results) => results[0]),
            );

            if (!newTheme)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create theme",
                );

            await setCache("theme", newTheme.id, newTheme);

            res.status(HttpStatusCode.Created).json(newTheme);
        } catch (error) {
            next(error);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { id: themeId } = validateThemePatchQuery.parse(req.params);

            let theme = await getCache("theme", themeId);
            if (!theme)
                theme = await execNormalized<APITheme>(
                    db.query.themesTable.findFirst({
                        where: eq(themesTable.id, BigInt(themeId)),
                    }),
                );

            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.authorId && BigInt(theme.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to update this theme",
                );

            const validatedTheme = validateThemePatchBody.parse(req.body);

            const updatedTheme = await execNormalized<APITheme>(
                db
                    .update(themesTable)
                    .set({
                        ...validatedTheme,
                        updatedAt: new Date(),
                    })
                    .where(eq(themesTable.id, BigInt(theme.id)))
                    .returning()
                    .then((results) => results[0]),
            );

            if (!updatedTheme)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update theme",
                );

            await setCache("theme", themeId, updatedTheme);

            res.status(HttpStatusCode.Success).json(updatedTheme);
        } catch (error) {
            next(error);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { id: themeId } = validateThemePatchQuery.parse(req.params);

            let theme = await getCache("theme", themeId);
            if (!theme)
                theme = await execNormalized<APITheme>(
                    db.query.themesTable.findFirst({
                        where: eq(themesTable.id, BigInt(themeId)),
                    }),
                );

            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.authorId && BigInt(theme.authorId) !== BigInt(user.id))
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to delete this theme",
                );

            await db
                .delete(themesTable)
                .where(eq(themesTable.id, BigInt(themeId)));

            await deleteCache("theme", themeId);

            res.status(HttpStatusCode.Success).send({
                id: theme.id,
            });
        } catch (error) {
            next(error);
        }
    }
}
