import {
    db,
    spaceMembersTable,
    spacesTable,
    userSettingsTable,
} from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { emitEvent, genSnowflake, getUser } from "@mutualzz/util";
import { validateSpaceGet, validateSpacePut } from "@mutualzz/validators";
import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class SpacesController {
    static async put(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { name } = validateSpacePut.parse(req.body);

            const space = await db.transaction(async (tx) => {
                const newSpace = await tx
                    .insert(spacesTable)
                    .values({
                        id: genSnowflake(),
                        name,
                        owner: user.id,
                    })
                    .returning()
                    .then((results) => results[0]);

                if (!newSpace)
                    throw new HttpException(
                        HttpStatusCode.InternalServerError,
                        "Failed to create space",
                    );

                await tx.insert(spaceMembersTable).values({
                    space: newSpace.id,
                    user: user.id,
                });

                await tx
                    .update(userSettingsTable)
                    .set({
                        spacePositions: sql`array_prepend(${newSpace.id}, COALESCE(${userSettingsTable.spacePositions}, ARRAY[]::text[]))`,
                    })
                    .where(eq(userSettingsTable.user, user.id));

                return newSpace;
            });

            await emitEvent({
                event: "SpaceAdded",
                user_id: user.id,
                data: space,
            });

            res.status(HttpStatusCode.Success).json(space);
        } catch (error) {
            next(error);
        }
    }

    static async getAll(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const spaces = await db
                .select()
                .from(spacesTable)
                .where(
                    sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.space} = ${spacesTable.id} AND ${spaceMembersTable.user} = ${user.id})`,
                );

            res.status(HttpStatusCode.Success).json(spaces);
        } catch (error) {
            next(error);
        }
    }

    static async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { id: spaceId } = validateSpaceGet.parse(req.params);

            const space = await db
                .select()
                .from(spacesTable)
                .where(
                    sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.space} = ${spacesTable.id} AND ${spaceMembersTable.user} = ${user.id}) AND ${spacesTable.id} = ${spaceId}`,
                )
                .then((results) => results[0]);

            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            res.status(HttpStatusCode.Success).json(space);
        } catch (error) {
            next(error);
        }
    }

    static async getBulk(req: Request, res: Response, next: NextFunction) {
        try {
            const user = await getUser(req.user?.id);
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "You are not logged in",
                );

            const { limit } = req.query;

            const spaces = await db
                .select()
                .from(spacesTable)
                .limit(typeof limit === "string" ? parseInt(limit, 10) : 50)
                .where(
                    sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.space} = ${spacesTable.id} AND ${spaceMembersTable.user} = ${user.id})`,
                );

            res.status(HttpStatusCode.Success).json(spaces);
        } catch (error) {
            next(error);
        }
    }
}
