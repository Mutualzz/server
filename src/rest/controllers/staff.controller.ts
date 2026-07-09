import {
  BitField,
  isStaffToggleableUserFlag,
  userFlags,
} from "@mutualzz/bitfield";
import { deleteCache, invalidateCache } from "@mutualzz/cache";
import {
  db,
  spacesTable,
  staffActionsTable,
  staffNotesTable,
  usersTable,
} from "@mutualzz/database";
import type {
  APIPrivateUser,
  APIStaffAction,
  APIStaffNote,
  APIStaffSession,
  APIUser,
  StaffActionType,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "@mutualzz/rest/util";
import {
  bucketName,
  buildAppealUrl,
  emitEvent,
  execNormalizedMany,
  fireAndForget,
  generateAppealToken,
  getUser,
  postmark,
  publicUserColumns,
  redis,
  requireFounder,
  requireStaff,
  resolveUserIdentifier,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  validateStaffActionsQuery,
  validateStaffCreateNoteBody,
  validateStaffDeleteUserBody,
  validateStaffDisableUserBody,
  validateStaffForceLogoutBody,
  validateStaffNotesQuery,
  validateStaffProfileUpdateBody,
  validateStaffRestrictUserBody,
  validateStaffSearchUsersQuery,
  validateStaffSessionParams,
  validateStaffSetFlagBody,
  validateStaffSetFlagParams,
  validateStaffUserParams,
  validateStaffWarnUserBody,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

const UNVERIFIED_FILTER = "Unverified";
const VERIFY_REMINDER_COOLDOWN_SECONDS = 60 * 60;
const staffActionUserColumns = {
  id: true,
  username: true,
  globalName: true,
  avatar: true,
} as const;

export default class StaffController {
  static async search(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { query, flag, after, limit } = validateStaffSearchUsersQuery.parse(
        req.query,
      );

      if (flag && flag !== UNVERIFIED_FILTER && !(flag in userFlags))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          `Unknown flag: ${flag}`,
        );

      const conditions = [];

      if (query) {
        conditions.push(
          or(
            ilike(usersTable.username, `%${query}%`),
            ilike(usersTable.globalName, `%${query}%`),
          ),
        );
      }

      if (flag === UNVERIFIED_FILTER) {
        const mask = userFlags.Verified;
        conditions.push(sql`(${usersTable.flags} & ${mask}) != ${mask}`);
      } else if (flag) {
        const mask = userFlags[flag as keyof typeof userFlags];
        conditions.push(sql`(${usersTable.flags} & ${mask}) = ${mask}`);
      }

      if (after) conditions.push(gt(usersTable.username, after));

      const users = await execNormalizedMany<APIUser>(
        db.query.usersTable.findMany({
          columns: publicUserColumns,
          where: and(...conditions),
          orderBy: asc(usersTable.username),
          limit,
        }),
      );

      res.status(HttpStatusCode.Success).json(users);
    } catch (err) {
      next(err);
    }
  }

  static async getUser(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);

      const user = await resolveUserIdentifier(userId, true);
      if (!user)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      res.status(HttpStatusCode.Success).json(user);
    } catch (err) {
      next(err);
    }
  }

  static async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { username, globalName, reason } =
        validateStaffProfileUpdateBody.parse(req.body);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const changes: {
        username?: string;
        globalName?: string | null;
      } = {};
      const changeSummary: string[] = [];

      if (username !== undefined && username !== target.username) {
        const usernameExists = await db.query.usersTable.findFirst({
          columns: { username: true },
          where: eq(usersTable.username, username),
        });

        if (usernameExists)
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "This username is already taken",
            [
              {
                path: "username",
                message: "This username is already taken",
              },
            ],
          );

        changes.username = username;
        changeSummary.push(`username: ${target.username} → ${username}`);
      }

      if (
        globalName !== undefined &&
        globalName !== (target.globalName ?? null)
      ) {
        changes.globalName = globalName;
        changeSummary.push(
          `display name: ${target.globalName ?? "(none)"} → ${globalName ?? "(none)"}`,
        );
      }

      if (Object.keys(changes).length === 0)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "No changes provided",
        );

      await db
        .update(usersTable)
        .set(changes)
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.profile_update" satisfies StaffActionType,
        reason: reason ?? changeSummary.join("; "),
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.updateProfile)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async sendVerifyReminder(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);

      const target = (await resolveUserIdentifier(
        userId,
        true,
      )) as APIPrivateUser | null;
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (
        BitField.fromString(userFlags, target.flags.toString()).has("Verified")
      )
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "This user is already verified",
        );

      const cooldownKey = `staffVerifyReminderCooldown:${target.id}`;
      const onCooldown = await redis.get(cooldownKey);

      if (onCooldown)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "A reminder was already sent recently, please wait before sending another",
        );

      const sentEmail = await postmark.sendEmailWithTemplate({
        From: "verify@mutualzz.com",
        To: target.email,
        MessageStream: "email-verification",
        TemplateAlias: "verify-email-reminder",
        TemplateModel: {
          username: target.username,
          email: target.email,
        },
      });

      if (sentEmail.ErrorCode !== 0)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to send verification reminder",
        );

      await redis.set(cooldownKey, "1", "EX", VERIFY_REMINDER_COOLDOWN_SECONDS);

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.verify_reminder_sent" satisfies StaffActionType,
        reason: null,
      });

      res.status(HttpStatusCode.Success).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async warnUser(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { reason } = validateStaffWarnUserBody.parse(req.body);

      const target = (await resolveUserIdentifier(
        userId,
        true,
      )) as APIPrivateUser | null;
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.warn" satisfies StaffActionType,
        reason,
      });

      let emailSent = false;
      try {
        const appealToken = await generateAppealToken(target.id);

        const sentEmail = await postmark.sendEmailWithTemplate({
          From: "moderation@mutualzz.com",
          To: target.email,
          MessageStream: "account-moderation",
          TemplateAlias: "account-warning",
          TemplateModel: {
            username: target.username,
            reason,
            appealUrl: buildAppealUrl(appealToken),
          },
        });

        emailSent = sentEmail.ErrorCode === 0;
      } catch {
        emailSent = false;
      }

      res.status(HttpStatusCode.Success).json({
        success: true,
        emailSent,
      });
    } catch (err) {
      next(err);
    }
  }

  static async setDisabled(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { disabled, reason } = validateStaffDisableUserBody.parse(req.body);

      const target = (await resolveUserIdentifier(
        userId,
        true,
      )) as APIPrivateUser | null;
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (BigInt(target.id) === BigInt(actor.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot disable your own account",
        );

      const newFlags = BitField.fromString(userFlags, target.flags.toString())
        .set("Disabled", disabled)
        .toBigInt();

      await db
        .update(usersTable)
        .set({ flags: newFlags })
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: (disabled
          ? "user.disable"
          : "user.enable") satisfies StaffActionType,
        reason: reason ?? null,
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      if (disabled) {
        fireAndForget(
          async () => {
            const appealToken = await generateAppealToken(target.id);

            const sentEmail = await postmark.sendEmailWithTemplate({
              From: "moderation@mutualzz.com",
              To: target.email,
              MessageStream: "account-moderation",
              TemplateAlias: "account-disabled",
              TemplateModel: {
                username: target.username,
                reason,
                appealUrl: buildAppealUrl(appealToken),
              },
            });

            if (sentEmail.ErrorCode !== 0)
              throw new Error(
                `Postmark ErrorCode ${sentEmail.ErrorCode}: ${sentEmail.Message}`,
              );
          },
          { label: "email:account-disabled" },
        );
      }

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.setDisabled)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async restrictUser(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { hours, reason } = validateStaffRestrictUserBody.parse(
        req.body,
      );

      const target = (await resolveUserIdentifier(
        userId,
        true,
      )) as APIPrivateUser | null;
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (BigInt(target.id) === BigInt(actor.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot restrict your own account",
        );

      const restrictedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);

      await db
        .update(usersTable)
        .set({ restrictedUntil, restrictionReason: reason })
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.restrict" satisfies StaffActionType,
        reason: `${reason} (until ${restrictedUntil.toISOString()})`,
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      fireAndForget(
        async () => {
          const appealToken = await generateAppealToken(target.id);

          const sentEmail = await postmark.sendEmailWithTemplate({
            From: "moderation@mutualzz.com",
            To: target.email,
            MessageStream: "account-moderation",
            TemplateAlias: "account-restricted",
            TemplateModel: {
              username: target.username,
              reason,
              until: restrictedUntil.toLocaleString(),
              appealUrl: buildAppealUrl(appealToken),
            },
          });

          if (sentEmail.ErrorCode !== 0)
            throw new Error(
              `Postmark ErrorCode ${sentEmail.ErrorCode}: ${sentEmail.Message}`,
            );
        },
        { label: "email:account-restricted" },
      );

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.restrictUser)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async liftRestriction(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      await db
        .update(usersTable)
        .set({ restrictedUntil: null, restrictionReason: null })
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.restrict_lift" satisfies StaffActionType,
        reason: null,
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.liftRestriction)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async setFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireFounder(req.user);

      const { userId, flag } = validateStaffSetFlagParams.parse(req.params);
      const { enabled, reason } = validateStaffSetFlagBody.parse(req.body);

      if (!isStaffToggleableUserFlag(flag))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          `Flag "${flag}" cannot be changed here`,
        );

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const newFlags = BitField.fromString(userFlags, target.flags.toString())
        .set(flag, enabled)
        .toBigInt();

      await db
        .update(usersTable)
        .set({ flags: newFlags })
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action:
          `user.flag.${flag}.${enabled ? "grant" : "revoke"}` satisfies StaffActionType,
        reason: reason ?? null,
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.setFlag)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { mode, reason, confirmUsername } = validateStaffDeleteUserBody.parse(
        req.body,
      );

      const target = (await resolveUserIdentifier(
        userId,
        true,
      )) as APIPrivateUser | null;
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (BigInt(target.id) === BigInt(actor.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot delete your own account",
        );

      if (confirmUsername !== target.username)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Username confirmation does not match",
        );

      const targetFlags = BitField.fromString(
        userFlags,
        target.flags.toString(),
      );

      if (mode === "hard") {
        requireFounder(actor);

        if (targetFlags.has("Founder"))
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Cannot hard delete a founder account",
          );

        const ownedSpaces = await db.query.spacesTable.findMany({
          columns: { id: true, icon: true },
          where: eq(spacesTable.ownerId, BigInt(target.id)),
        });

        await revokeAllSessions(target.id);

        const auditReason = `@${target.username} (${target.id}) — ${reason}`;

        await db.transaction(async (tx) => {
          if (ownedSpaces.length > 0) {
            await tx
              .delete(spacesTable)
              .where(eq(spacesTable.ownerId, BigInt(target.id)))
              .execute();
          }

          await tx.insert(staffActionsTable).values({
            id: BigInt(Snowflake.generate()),
            actorId: BigInt(actor.id),
            targetId: BigInt(target.id),
            action: "user.hard_delete" satisfies StaffActionType,
            reason: auditReason,
          });

          await tx
            .delete(usersTable)
            .where(eq(usersTable.id, BigInt(target.id)))
            .execute();
        });

        await Promise.all([
          deleteCache("authUser", target.id),
          deleteCache("user", target.id),
        ]);

        for (const space of ownedSpaces) {
          const spaceId = space.id.toString();

          void deleteCache("space", spaceId);
          void deleteCache("spaceMembers", spaceId);
          void invalidateCache("spaceHydrated", spaceId);

          fireAndForget(
            () =>
              emitEvent({
                event: "SpaceDelete",
                space_id: spaceId,
                data: { id: spaceId },
              }),
            { label: "event:SpaceDelete (staff.hardDeleteUser)" },
          );

          if (!space.icon) continue;

          const isGif = space.icon.startsWith("a_");
          const storedExt = isGif ? "gif" : "png";

          fireAndForget(
            async () => {
              await s3Client.send(
                new DeleteObjectCommand({
                  Bucket: bucketName,
                  Key: `icons/spaces/${spaceId}/${space.icon}.${storedExt}`,
                }),
              );
            },
            { label: "s3:delete-space-icon (staff.hardDeleteUser)" },
          );
        }

        fireAndForget(
          () =>
            emitEvent({
              event: "UserForceLogout",
              user_id: target.id,
              data: {},
            }),
          { label: "event:UserForceLogout (staff.hardDeleteUser)" },
        );

        res.status(HttpStatusCode.Success).json({ success: true, hard: true });
        return;
      }

      if (targetFlags.has("Deleted"))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "This account has already been soft deleted",
        );

      await revokeAllSessions(target.id);

      const newFlags = targetFlags.set("Deleted", true).toBigInt();

      await db
        .update(usersTable)
        .set({ flags: newFlags })
        .where(eq(usersTable.id, BigInt(target.id)))
        .execute();

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.delete" satisfies StaffActionType,
        reason,
      });

      await Promise.all([
        deleteCache("authUser", target.id),
        deleteCache("user", target.id),
      ]);

      fireAndForget(
        () =>
          emitEvent({
            event: "UserForceLogout",
            user_id: target.id,
            data: {},
          }),
        { label: "event:UserForceLogout (staff.deleteUser)" },
      );

      const updated = await getUser(target.id, true);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to delete user",
        );

      fireAndForget(
        () =>
          emitEvent({
            event: "UserUpdate",
            user_id: updated.id,
            data: updated,
          }),
        { label: "event:UserUpdate (staff.deleteUser)" },
      );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async forceLogout(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { reason } = validateStaffForceLogoutBody.parse(req.body);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (BigInt(target.id) === BigInt(actor.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot force logout your own account",
        );

      await revokeAllSessions(target.id);

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.force_logout" satisfies StaffActionType,
        reason: reason ?? null,
      });

      fireAndForget(
        () =>
          emitEvent({
            event: "UserForceLogout",
            user_id: target.id,
            data: {},
          }),
        { label: "event:UserForceLogout (staff.forceLogout)" },
      );

      res.status(HttpStatusCode.Success).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async getSessions(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const sessions = await listSessions(target.id);

      const sanitized: APIStaffSession[] = sessions
        .map(({ sessionId, createdAt, lastUsedAt }) => ({
          sessionId,
          createdAt,
          lastUsedAt,
        }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);

      res.status(HttpStatusCode.Success).json(sanitized);
    } catch (err) {
      next(err);
    }
  }

  static async revokeSession(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId, sessionId } = validateStaffSessionParams.parse(
        req.params,
      );

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const sessions = await listSessions(target.id);
      const match = sessions.find((s) => s.sessionId === sessionId);
      if (!match?.token)
        throw new HttpException(HttpStatusCode.NotFound, "Session not found");

      await revokeSession(match.token);

      await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actor.id),
        targetId: BigInt(target.id),
        action: "user.session_revoke" satisfies StaffActionType,
        reason: null,
      });

      res.status(HttpStatusCode.Success).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  static async getActions(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { before, limit } = validateStaffActionsQuery.parse(req.query);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const conditions = [eq(staffActionsTable.targetId, BigInt(target.id))];
      if (before) conditions.push(lt(staffActionsTable.id, BigInt(before)));

      const actions = await execNormalizedMany<APIStaffAction>(
        db.query.staffActionsTable.findMany({
          where: and(...conditions),
          orderBy: desc(staffActionsTable.createdAt),
          limit,
          with: {
            actor: { columns: staffActionUserColumns },
            target: { columns: staffActionUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(actions);
    } catch (err) {
      next(err);
    }
  }

  static async getAllActions(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { before, limit } = validateStaffActionsQuery.parse(req.query);

      const actions = await execNormalizedMany<APIStaffAction>(
        db.query.staffActionsTable.findMany({
          where: before ? lt(staffActionsTable.id, BigInt(before)) : undefined,
          orderBy: desc(staffActionsTable.createdAt),
          limit,
          with: {
            actor: { columns: staffActionUserColumns },
            target: { columns: staffActionUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(actions);
    } catch (err) {
      next(err);
    }
  }

  static async getNotes(req: Request, res: Response, next: NextFunction) {
    try {
      requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { before, limit } = validateStaffNotesQuery.parse(req.query);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const conditions = [eq(staffNotesTable.targetId, BigInt(target.id))];
      if (before) conditions.push(lt(staffNotesTable.id, BigInt(before)));

      const notes = await execNormalizedMany<APIStaffNote>(
        db.query.staffNotesTable.findMany({
          where: and(...conditions),
          orderBy: desc(staffNotesTable.createdAt),
          limit,
          with: {
            author: { columns: staffActionUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(notes);
    } catch (err) {
      next(err);
    }
  }

  static async createNote(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = requireStaff(req.user);

      const { userId } = validateStaffUserParams.parse(req.params);
      const { content } = validateStaffCreateNoteBody.parse(req.body);

      const target = await resolveUserIdentifier(userId, true);
      if (!target)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const noteId = Snowflake.generate();

      await db.insert(staffNotesTable).values({
        id: BigInt(noteId),
        targetId: BigInt(target.id),
        authorId: BigInt(actor.id),
        content,
      });

      const [note] = await execNormalizedMany<APIStaffNote>(
        db.query.staffNotesTable.findMany({
          where: eq(staffNotesTable.id, BigInt(noteId)),
          limit: 1,
          with: {
            author: { columns: staffActionUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Created).json(note);
    } catch (err) {
      next(err);
    }
  }
}
