import { db, rolesTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { getSpace, requireSpacePermissions, Snowflake } from "@mutualzz/util";
import { validateSpaceParam } from "@mutualzz/validators";
import { eq, max } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

export default class RolesController {
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateSpaceParam.parse(req.params);

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            await requireSpacePermissions({
                spaceId,
                userId: user.id,
                needed: ["ManageRoles"],
            });

            const maxPosition = await db
                .select({
                    max: max(rolesTable.position),
                })
                .from(rolesTable)
                .where(eq(rolesTable.spaceId, BigInt(spaceId)))
                .then((res) => res[0].max);

            const newRole = await db.insert(rolesTable).values({
                id: BigInt(Snowflake.generate()),
                spaceId: BigInt(spaceId),
                name: "New Role",
                color: "#6c5a6d",
                position: (maxPosition ?? -1) + 1,
            });
        } catch (error) {
            next(error);
        }
    }
}
