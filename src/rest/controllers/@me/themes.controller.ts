import { ThemeModel, UserModel } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { validateThemePut } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import { genSnowflake } from "util/Common";

export default class MeThemesController {
    static async putTheme(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await UserModel.findById(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const validatedTheme = validateThemePut.parse(req.body);

            const similarNamedThemes = await ThemeModel.find({
                name: validatedTheme.name,
            });

            // Generate a new name for the theme if there are similar named themes
            const newName =
                similarNamedThemes.length > 0
                    ? validatedTheme.name +
                      " " +
                      (similarNamedThemes.length + 1)
                    : validatedTheme.name;

            const newTheme = new ThemeModel({
                _id: genSnowflake(),
                ...validatedTheme,
                name: newName,
                createdBy: user.id,
                createdAt: new Date(),
                createdTimestamp: Date.now(),
                updatedAt: new Date(),
                updatedTimestamp: Date.now(),
            });

            user.themes.push(newTheme.id);

            await newTheme.save();
            await user.save();

            res.status(HttpStatusCode.Created).json(newTheme);
        } catch (error) {
            next(error);
        }
    }

    static async patchTheme(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await UserModel.findById(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const theme = await ThemeModel.findById(req.query.id);
            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.createdBy !== user.id)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to update this theme",
                );

            const validatedTheme = validateThemePut.parse(req.body);

            theme.name = validatedTheme.name;
            theme.description = validatedTheme.description;
            theme.type = validatedTheme.type;
            theme.colors = validatedTheme.colors;
            theme.typography = validatedTheme.typography;
            theme.updatedAt = new Date();
            theme.updatedTimestamp = Date.now();

            await theme.save();

            res.status(HttpStatusCode.Success).json(theme);
        } catch (error) {
            next(error);
        }
    }

    static async deleteTheme(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await UserModel.findById(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const theme = await ThemeModel.findById(req.query.id);
            if (!theme)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Theme not found",
                );

            if (theme.createdBy !== user.id)
                throw new HttpException(
                    HttpStatusCode.Forbidden,
                    "You are not allowed to delete this theme",
                );

            await theme.deleteOne();
            user.themes = user.themes.filter((id) => id !== theme.id);
            await user.save();

            res.status(HttpStatusCode.Success).send({
                id: theme.id,
            });
        } catch (error) {
            next(error);
        }
    }
}
