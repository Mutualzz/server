import {
    BitField,
    isStaffToggleableUserFlag,
    userFlags,
} from "@mutualzz/bitfield";
import { deleteCache } from "@mutualzz/cache";
import { db, staffActionsTable, usersTable } from "@mutualzz/database";
import type {
    APIPrivateUser,
    APIStaffAction,
    APIStaffSession,
    APIUser,
    StaffActionType,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { listSessions, revokeAllSessions, revokeSession } from "@mutualzz/rest/util";
import {
    emitEvent,
    execNormalizedMany,
    fireAndForget,
    getUser,
    postmark,
    publicUserColumns,
    redis,
    requireFounder,
    requireStaff,
    resolveUserIdentifier,
    Snowflake,
} from "@mutualzz/util";
import {
    validateStaffActionsQuery,
    validateStaffDisableUserBody,
    validateStaffForceLogoutBody,
    validateStaffProfileUpdateBody,
    validateStaffSearchUsersQuery,
    validateStaffSessionParams,
    validateStaffSetFlagBody,
    validateStaffSetFlagParams,
    validateStaffUserParams,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

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

            const { query, flag, after, limit } =
                validateStaffSearchUsersQuery.parse(req.query);

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
                conditions.push(
                    sql`(${usersTable.flags} & ${mask}) != ${mask}`,
                );
            } else if (flag) {
                const mask = userFlags[flag as keyof typeof userFlags];
                conditions.push(
                    sql`(${usersTable.flags} & ${mask}) = ${mask}`,
                );
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
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

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
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

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
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            if (BitField.fromString(userFlags, target.flags.toString()).has(
                "Verified",
            ))
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

            await redis.set(
                cooldownKey,
                "1",
                "EX",
                VERIFY_REMINDER_COOLDOWN_SECONDS,
            );

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

    static async setDisabled(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);

            const { userId } = validateStaffUserParams.parse(req.params);
            const { disabled, reason } = validateStaffDisableUserBody.parse(
                req.body,
            );

            const target = await resolveUserIdentifier(userId, true);
            if (!target)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            if (BigInt(target.id) === BigInt(actor.id))
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    "Cannot disable your own account",
                );

            const newFlags = BitField.fromString(
                userFlags,
                target.flags.toString(),
            )
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

    static async setFlag(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireFounder(req.user);

            const { userId, flag } = validateStaffSetFlagParams.parse(
                req.params,
            );
            const { enabled, reason } = validateStaffSetFlagBody.parse(
                req.body,
            );

            if (!isStaffToggleableUserFlag(flag))
                throw new HttpException(
                    HttpStatusCode.BadRequest,
                    `Flag "${flag}" cannot be changed here`,
                );

            const target = await resolveUserIdentifier(userId, true);
            if (!target)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            const newFlags = BitField.fromString(
                userFlags,
                target.flags.toString(),
            )
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

    static async forceLogout(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);

            const { userId } = validateStaffUserParams.parse(req.params);
            const { reason } = validateStaffForceLogoutBody.parse(req.body);

            const target = await resolveUserIdentifier(userId, true);
            if (!target)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

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
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

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
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

            const sessions = await listSessions(target.id);
            const match = sessions.find((s) => s.sessionId === sessionId);
            if (!match?.token)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Session not found",
                );

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
            const { before, limit } = validateStaffActionsQuery.parse(
                req.query,
            );

            const target = await resolveUserIdentifier(userId, true);
            if (!target)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "User not found",
                );

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

            const { before, limit } = validateStaffActionsQuery.parse(
                req.query,
            );

            const actions = await execNormalizedMany<APIStaffAction>(
                db.query.staffActionsTable.findMany({
                    where: before
                        ? lt(staffActionsTable.id, BigInt(before))
                        : undefined,
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
}
