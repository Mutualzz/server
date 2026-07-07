import { db, rolesTable } from "@mutualzz/database";
import { type APIRole, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
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
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  assertEveryoneUpdateRules,
  assertHierarchyCanAffectRole,
  assertHierarchyCanSetPosition,
  assertNoPermissionEscalation,
  assertNotEveryoneDelete,
  getActorTopRolePosition,
} from "@mutualzz/rest/util";
import { getCache, invalidateCache } from "@mutualzz/cache";
import { permissionFlags } from "@mutualzz/bitfield";

export default class RolesController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateSpaceParam.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      if (BigInt(space.ownerId) !== BigInt(user.id)) {
        const me = await getMember(space.id, user.id);
        if (!me)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a member of this space",
          );
      }

      let roles = await getCache("roles", spaceId);
      if (roles) return res.status(HttpStatusCode.Success).json(roles);

      roles = await execNormalizedMany<APIRole>(
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

      const { spaceId, roleId } = validateRoleParams.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      if (BigInt(space.ownerId) !== BigInt(user.id)) {
        const me = await getMember(space.id, user.id);
        if (!me)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a member of this space",
          );
      }

      let role = await getCache("role", roleId);
      if (role) return res.status(HttpStatusCode.Success).json(role);

      role = await execNormalized<APIRole | null>(
        db
          .select()
          .from(rolesTable)
          .where(
            and(
              eq(rolesTable.id, BigInt(roleId)),
              eq(rolesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!role)
        throw new HttpException(HttpStatusCode.NotFound, "Role not found");

      res.status(HttpStatusCode.Success).json(role);
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateSpaceParam.parse(req.params);

      const space = await getSpaceHydrated(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageRoles"],
      });

      const { newRole, shiftedRoles } = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${spaceId}, 1))`,
        );

        const shiftedRoles = await tx
          .update(rolesTable)
          .set({ position: sql`${rolesTable.position} + 1` })
          .where(
            and(
              eq(rolesTable.spaceId, BigInt(spaceId)),
              gt(rolesTable.position, 0),
            ),
          )
          .returning();

        const newRole = await tx
          .insert(rolesTable)
          .values({
            id: BigInt(Snowflake.generate()),
            spaceId: BigInt(spaceId),
            name: "New Role",
            color: "#99aab5",
            position: 1,
            allow: 0n,
            deny: 0n,
          })
          .returning()
          .then((res) => (res.length ? res[0] : null));

        return { newRole, shiftedRoles };
      });

      if (!newRole)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create role",
        );

      res.status(HttpStatusCode.Success).json(newRole);

      fireAndForgetAll([
        {
          label: "event:RoleCreate",
          run: () =>
            emitEvent({
              event: "RoleCreate",
              space_id: space.id,
              data: newRole,
            }),
        },
        ...shiftedRoles.map((role) => ({
          label: `event:RoleUpdate:${role.id}`,
          run: () =>
            emitEvent({
              event: "RoleUpdate",
              space_id: space.id,
              data: role,
            }),
        })),
        {
          label: "cache:invalidate:everyoneRole",
          run: () => invalidateCache("everyoneRole", spaceId),
        },
        {
          label: "cache:invalidate:memberRoles",
          run: () => invalidateCache("memberRoles", spaceId),
        },
        {
          label: "cache:invalidate:spaceHydrated",
          run: () => invalidateCache("spaceHydrated", spaceId),
        },
      ]);
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId, roleId } = validateRoleParams.parse(req.params);

      const space = await getSpaceHydrated(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      // Must have ManageRoles (Admin/Owner passes too)
      const { permissions: actorPermissions } = await requireSpacePermissions({
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
        .then((res) => (res.length ? res[0] : null));

      if (!role)
        throw new HttpException(HttpStatusCode.NotFound, "Role not found");

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

      res.status(HttpStatusCode.Success).json({
        id: role.id,
        spaceId: space.id,
      });

      fireAndForgetAll([
        {
          label: "event:RoleDelete",
          run: () =>
            emitEvent({
              event: "RoleDelete",
              space_id: space.id,
              data: {
                id: role.id,
                spaceId: space.id,
              },
            }),
        },
        {
          label: "cache:invalidate:channelOverwrites",
          run: () => invalidateCache("channelOverwrites", spaceId),
        },
        {
          label: "cache:invalidate:everyoneRole",
          run: () => invalidateCache("everyoneRole", spaceId),
        },
        {
          label: "cache:invalidate:memberRoles",
          run: () => invalidateCache("memberRoles", spaceId),
        },
        {
          label: "cache:invalidate:spaceHydrated",
          run: () => invalidateCache("spaceHydrated", spaceId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId, roleId } = validateRoleParams.parse(req.params);

      const space = await getSpaceHydrated(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      const { permissions: actorPermissions } = await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageRoles"],
      });

      const role = await execNormalized<APIRole | null>(
        db
          .select()
          .from(rolesTable)
          .where(
            and(
              eq(rolesTable.id, BigInt(roleId)),
              eq(rolesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!role)
        throw new HttpException(HttpStatusCode.NotFound, "Role not found");

      const { name, color, position, mentionable, hoist, allow, deny } =
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

      // Prevent permission escalation on allow bits
      if (allow != null) {
        const newBits = BigInt(allow);
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
          allow: allow == null ? BigInt(role.allow) : BigInt(allow),
          deny: deny == null ? BigInt(role.deny) : BigInt(deny),
        })
        .where(
          and(
            eq(rolesTable.id, BigInt(roleId)),
            eq(rolesTable.spaceId, BigInt(spaceId)),
          ),
        )
        .returning()
        .then((res) => (res.length ? res[0] : null));

      if (!updatedRole)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update role",
        );

      res.status(HttpStatusCode.Success).json(updatedRole);

      fireAndForgetAll([
        {
          label: "event:RoleUpdate",
          run: () =>
            emitEvent({
              event: "RoleUpdate",
              space_id: space.id,
              data: updatedRole,
            }),
        },
        {
          label: "cache:invalidate:channelOverwrites",
          run: () => invalidateCache("channelOverwrites", spaceId),
        },
        {
          label: "cache:invalidate:everyoneRole",
          run: () => invalidateCache("everyoneRole", spaceId),
        },
        {
          label: "cache:invalidate:memberRoles",
          run: () => invalidateCache("memberRoles", spaceId),
        },
        {
          label: "cache:invalidate:spaceHydrated",
          run: () => invalidateCache("spaceHydrated", spaceId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
