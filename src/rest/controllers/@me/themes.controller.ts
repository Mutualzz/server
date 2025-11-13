import { db, themesTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { genSnowflake, getUser } from "@mutualzz/util";
import {
    validateThemePatchBody,
    validateThemePatchQuery,
    validateThemePut,
} from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class MeThemesController {
    static async put(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const validatedTheme = validateThemePut.parse(req.body);

            const similarNamedThemes = await db
                .select({
                    name: themesTable.name,
                })
                .from(themesTable)
                .where(and(eq(themesTable.author, user.id)))
                .then((themes) =>
                    themes.filter((t) =>
                        t.name.startsWith(validatedTheme.name),
                    ),
                );

            // Generate a new name for the theme if there are similar named themes
            let newName = validatedTheme.name;
            if (similarNamedThemes.length > 0) {
                const existingNames = new Set(
                    similarNamedThemes.map((t) => t.name),
                );
                let counter = 2;
                while (existingNames.has(`${validatedTheme.name} ${counter}`)) {
                    counter++;
                }
                newName = `${validatedTheme.name} ${counter}`;
            }

            const newTheme = await db
                .insert(themesTable)
                .values({
                    id: genSnowflake(),
                    ...validatedTheme,
                    name: newName,
                    author: user.id,
                })
                .returning()
                .then((results) => results[0]);

            if (!newTheme)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create theme",
                );

            res.status(HttpStatusCode.Created).json(newTheme);
        } catch (error) {
            next(error);
        }
    }

    static async patch(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { id: themeId } = validateThemePatchQuery.parse(req.params);

            if (!themeId)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Theme ID is required",
                );

            const theme = await db
                .select()
                .from(themesTable)
                .where(eq(themesTable.id, themeId))
                .then((results) => results[0]);

            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.author !== user.id)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to update this theme",
                );

            const validatedTheme = validateThemePatchBody.parse(req.body);

            let newName = theme.name;
            if (validatedTheme.name && validatedTheme.name !== theme.name) {
                const similarNamedThemes = await db
                    .select({
                        name: themesTable.name,
                    })
                    .from(themesTable)
                    .where(eq(themesTable.author, user.id))
                    .then((themes) =>
                        themes.filter((t) =>
                            t.name.startsWith(
                                validatedTheme.name ?? theme.name,
                            ),
                        ),
                    );

                if (similarNamedThemes.length > 0) {
                    const existingNames = new Set(
                        similarNamedThemes.map((t) => t.name),
                    );
                    let counter = 2;
                    while (
                        existingNames.has(`${validatedTheme.name} ${counter}`)
                    ) {
                        counter++;
                    }
                    newName = `${validatedTheme.name} ${counter}`;
                } else {
                    newName = validatedTheme.name;
                }
            }

            const updatedTheme = await db
                .update(themesTable)
                .set({
                    ...validatedTheme,
                    name: newName,
                    updated: new Date(),
                })
                .where(eq(themesTable.id, theme.id))
                .returning()
                .then((results) => results[0]);

            res.status(HttpStatusCode.Success).json(updatedTheme);
        } catch (error) {
            next(error);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { id: themeId } = validateThemePatchQuery.parse(req.params);
            if (!themeId)
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Theme ID is required",
                );

            const theme = await db
                .select()
                .from(themesTable)
                .where(eq(themesTable.id, themeId))
                .then((results) => results[0]);

            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.author !== user.id)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to delete this theme",
                );

            await db.delete(themesTable).where(eq(themesTable.id, themeId));

            res.status(HttpStatusCode.Success).send({
                id: theme.id,
            });
        } catch (error) {
            next(error);
        }
    }
}
