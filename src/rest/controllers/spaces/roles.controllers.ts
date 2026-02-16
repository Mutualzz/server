import { db, rolesTable } from "@mutualzz/database";
import { type APIRole, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    emitEvent,
    execNormalized,
    execNormalizedMany,
    getMember,
    getSpace,
    getSpaceHydrated,
    requireSpacePermissions,
    Snowflake,
} from "@mutualzz/util";
import {
    validateRoleParams,
    validateRoleUpdate,
    validateSpaceParam,
} from "@mutualzz/validators";
import { and, asc, eq, max } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
    assertEveryoneUpdateRules,
    assertHierarchyCanAffectRole,
    assertHierarchyCanSetPosition,
    assertNoPermissionEscalation,
    assertNotEveryoneDelete,
    getActorTopRolePosition,
} from "@mutualzz/rest/util";
import { invalidateCache } from "@mutualzz/cache";
import { permissionFlags } from "@mutualzz/permissions";

export default class RolesController {
    static async getAll(req: Request, res: Response, next: NextFunction) {
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

            if (BigInt(space.ownerId) !== BigInt(user.id)) {
                const me = await getMember(space.id, user.id);
                if (!me)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You are not a member of this space",
                    );
            }

            const roles = await execNormalizedMany<APIRole>(
                db.query.rolesTable.findMany({
                    where: eq(rolesTable.spaceId, BigInt(spaceId)),
                    orderBy: asc(rolesTable.position),
                }),
            );

            res.status(HttpStatusCode.Success).json(roles);
        } catch (err) {
            next(err);
        }
    }

    static async getOne(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId, roleId } = validateRoleParams.parse(req.params);

            const space = await getSpace(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            if (BigInt(space.ownerId) !== BigInt(user.id)) {
                const me = await getMember(space.id, user.id);
                if (!me)
                    throw new HttpException(
                        HttpStatusCode.Forbidden,
                        "You are not a member of this space",
                    );
            }

            const role = await execNormalized<APIRole>(
                db
                    .select()
                    .from(rolesTable)
                    .where(
                        and(
                            eq(rolesTable.id, BigInt(roleId)),
                            eq(rolesTable.spaceId, BigInt(spaceId)),
                        ),
                    )
                    .then((res) => res[0]),
            );

            if (!role)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Role not found",
                );

            res.status(HttpStatusCode.Success).json(role);
        } catch (err) {
            next(err);
        }
    }

    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { spaceId } = validateSpaceParam.parse(req.params);

            const space = await getSpaceHydrated(spaceId);
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

            const newRole = await db
                .insert(rolesTable)
                .values({
                    id: BigInt(Snowflake.generate()),
                    spaceId: BigInt(spaceId),
                    name: "New Role",
                    color: "#99aab5",
                    position: (maxPosition ?? -1) + 1,
                })
                .returning()
                .then((res) => res[0]);

            if (!newRole)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to create role",
                );

            await invalidateCache("spaceHydrated", spaceId);
            await emitEvent({
                event: "RoleCreate",
                space_id: space.id,
                data: newRole,
            });

            res.status(HttpStatusCode.Success).json(newRole);
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

            const { spaceId, roleId } = validateRoleParams.parse(req.params);

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            // Must have ManageRoles (Admin/Owner passes too)
            const { permissions: actorPermissions } =
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["ManageRoles"],
                });

            assertNotEveryoneDelete(spaceId, roleId);

            const role = await db
                .select()
                .from(rolesTable)
                .where(
                    and(
                        eq(rolesTable.id, BigInt(roleId)),
                        eq(rolesTable.spaceId, BigInt(spaceId)),
                    ),
                )
                .then((res) => res[0]);

            if (!role)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Role not found",
                );

            const actorIsOwner = String(user.id) === String(space.ownerId);
            const actorIsAdmin =
                (actorPermissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            if (!actorIsOwner && !actorIsAdmin) {
                const actorTopPos = await getActorTopRolePosition(
                    String(spaceId),
                    String(user.id),
                );
                assertHierarchyCanAffectRole(
                    actorIsOwner,
                    actorIsAdmin,
                    actorTopPos,
                    role.position,
                );
            }

            await db
                .delete(rolesTable)
                .where(
                    and(
                        eq(rolesTable.id, BigInt(roleId)),
                        eq(rolesTable.spaceId, BigInt(spaceId)),
                    ),
                )
                .execute();

            await invalidateCache("spaceHydrated", spaceId);

            await emitEvent({
                event: "RoleDelete",
                space_id: space.id,
                data: role,
            });

            res.status(HttpStatusCode.Success).json(role);
        } catch (err) {
            next(err);
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

            const { spaceId, roleId } = validateRoleParams.parse(req.params);

            const space = await getSpaceHydrated(spaceId);
            if (!space)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Space not found",
                );

            const { permissions: actorPermissions } =
                await requireSpacePermissions({
                    spaceId,
                    userId: user.id,
                    needed: ["ManageRoles"],
                });

            const role = await execNormalized<APIRole>(
                db
                    .select()
                    .from(rolesTable)
                    .where(
                        and(
                            eq(rolesTable.id, BigInt(roleId)),
                            eq(rolesTable.spaceId, BigInt(spaceId)),
                        ),
                    )
                    .then((res) => res[0]),
            );

            if (!role)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Role not found",
                );

            const { name, color, position, mentionable, hoist, permissions } =
                validateRoleUpdate.parse(req.body);

            assertEveryoneUpdateRules(spaceId, role, { name, position });

            const actorIsOwner = String(user.id) === String(space.ownerId);
            const actorIsAdmin =
                (actorPermissions.bits & permissionFlags.Administrator) ===
                permissionFlags.Administrator;

            const actorBits = actorPermissions.bits;

            let actorTopPos = -1;
            if (!actorIsOwner && !actorIsAdmin) {
                actorTopPos = await getActorTopRolePosition(
                    String(spaceId),
                    String(user.id),
                );

                assertHierarchyCanAffectRole(
                    actorIsOwner,
                    actorIsAdmin,
                    actorTopPos,
                    role.position,
                );

                if (position != null) {
                    assertHierarchyCanSetPosition(
                        actorIsOwner,
                        actorIsAdmin,
                        actorTopPos,
                        position,
                    );
                }
            }

            // Prevent permission escalation
            if (permissions != null) {
                const newBits = BigInt(permissions);
                assertNoPermissionEscalation(
                    actorIsOwner,
                    actorIsAdmin,
                    actorBits,
                    newBits,
                );
            }

            const updatedRole = await db
                .update(rolesTable)
                .set({
                    name: name ?? role.name,
                    color: color ?? role.color,
                    position: position ?? role.position,
                    mentionable: mentionable ?? role.mentionable,
                    hoist: hoist ?? role.hoist,
                    permissions:
                        permissions != null
                            ? BigInt(permissions)
                            : BigInt(role.permissions),
                })
                .where(
                    and(
                        eq(rolesTable.id, BigInt(roleId)),
                        eq(rolesTable.spaceId, BigInt(spaceId)),
                    ),
                )
                .returning()
                .then((res) => res[0]);

            if (!updatedRole)
                throw new HttpException(
                    HttpStatusCode.InternalServerError,
                    "Failed to update role",
                );

            await invalidateCache("spaceHydrated", spaceId);

            await emitEvent({
                event: "RoleUpdate",
                space_id: space.id,
                data: updatedRole,
            });

            res.status(HttpStatusCode.Success).json(updatedRole);
        } catch (err) {
            next(err);
        }
    }
}
