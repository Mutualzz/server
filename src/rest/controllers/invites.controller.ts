import { deleteCache, getCache, invalidateCache, setCache, } from "@mutualzz/cache";
import { db, invitesTable, relationshipsTable, spaceMembersTable } from "@mutualzz/database";
import type { APIInvite, APIRelationship } from "@mutualzz/types";
import {
  HttpException,
  HttpStatusCode,
  InviteType,
  RelationshipType,
} from "@mutualzz/types";
import {
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  generateInviteCode,
  getSpace,
  getUser,
  requireChannelPermissions,
  requireNotRestricted,
  requireSpacePermissions,
  Snowflake,
} from "@mutualzz/util";
import {
  validateInviteBodyPatch,
  validateInviteBodyPost,
  validateInviteCodeParam,
  validateInviteParamsCode,
  validateInviteParamsGet,
} from "@mutualzz/validators";
import dayjs from "dayjs";
import { and, count, eq, gte } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

// NOTE: Eventually we will need to implement other types of invites.
export default class InvitesController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { spaceId } = validateInviteParamsGet.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      let invites = await getCache("invites", spaceId);
      if (invites) return res.status(HttpStatusCode.Success).json(invites);

      invites = await execNormalizedMany<APIInvite>(
        db.query.invitesTable.findMany({
          with: {
            inviter: true,
          },
          where: eq(invitesTable.spaceId, BigInt(spaceId)),
        }),
      );

      let hadExpired = false;

      const filtered: typeof invites = [];

      for (const invite of invites) {
        if (invite.expiresAt && dayjs().isAfter(dayjs(invite.expiresAt))) {
          hadExpired = true;
          await db
            .delete(invitesTable)
            .where(eq(invitesTable.code, invite.code));

          await deleteCache("invite", invite.code);
          continue;
        }

        filtered.push(invite);
      }

      invites = filtered;

      if (hadExpired) await invalidateCache("invites", spaceId);
      await setCache("invites", spaceId, invites);

      return res.status(HttpStatusCode.Success).json(invites);
    } catch (err) {
      next(err);
    }
  }

  static async getOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { spaceId, code } = validateInviteParamsCode.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");
      let invite = await getCache("invite", code);
      if (invite) return res.status(HttpStatusCode.Success).json(invite);

      invite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          where: and(
            eq(invitesTable.code, code),
            eq(invitesTable.spaceId, BigInt(spaceId)),
          ),
        }),
      );

      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      if (invite.expiresAt && dayjs().isAfter(dayjs(invite.expiresAt))) {
        await db.delete(invitesTable).where(eq(invitesTable.code, code));
        await deleteCache("invite", code);
        await invalidateCache("invites", spaceId);
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");
      }

      await setCache("invite", code, invite);

      return res.status(HttpStatusCode.Success).json(invite);
    } catch (err) {
      next(err);
    }
  }

  static async getFromCode(req: Request, res: Response, next: NextFunction) {
    try {
      const { code } = validateInviteParamsCode
        .pick({ code: true })
        .parse(req.params);

      const viewerId = req.user?.id;

      const invite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          with: {
            space: viewerId
              ? {
                  with: {
                    members: {
                      where: eq(
                        spaceMembersTable.userId,
                        BigInt(viewerId),
                      ),
                    },
                  },
                }
              : true,
            channel: { columns: { id: true, name: true, type: true } },
            user: true,
            inviter: true,
          },
          where: eq(invitesTable.code, code),
        }),
      );

      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      if (invite.expiresAt && dayjs().isAfter(dayjs(invite.expiresAt))) {
        await db.delete(invitesTable).where(eq(invitesTable.code, code));

        await deleteCache("invite", code);

        if (invite.spaceId) await invalidateCache("invites", invite.spaceId);

        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");
      }

      return res.status(HttpStatusCode.Success).json(invite);
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateInviteParamsCode
        .pick({
          spaceId: true,
        })
        .parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      const { channelId } = validateInviteBodyPost.parse(req.body);

      await requireChannelPermissions({
        channelId,
        userId: user.id,
        needed: ["CreateInvites"],
      });

      const reuseWindowSecs = 60;

      const recentInvite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          where: and(
            eq(invitesTable.channelId, BigInt(channelId)),
            eq(invitesTable.spaceId, BigInt(spaceId)),
            gte(
              invitesTable.createdAt,
              dayjs().subtract(reuseWindowSecs, "seconds").toDate(),
            ),
          ),
        }),
      );

      if (recentInvite)
        return res.status(HttpStatusCode.Success).json(recentInvite);

      const totalInvites = await db
        .select({
          count: count(invitesTable.code),
        })
        .from(invitesTable)
        .where(eq(invitesTable.spaceId, BigInt(spaceId)))
        .then((r) => r[0].count);

      if (totalInvites > 20) {
        const oldestInvite = await execNormalized<APIInvite>(
          db.query.invitesTable.findFirst({
            where: eq(invitesTable.spaceId, BigInt(spaceId)),
            orderBy: invitesTable.createdAt,
          }),
        );

        if (oldestInvite)
          return res.status(HttpStatusCode.Success).json(oldestInvite);
      }

      const code = generateInviteCode();

      const newInvite = await execNormalized<APIInvite>(
        db
          .insert(invitesTable)
          .values({
            code,
            type: InviteType.Space,
            spaceId: BigInt(spaceId),
            inviterId: BigInt(user.id),
            channelId: BigInt(channelId),
            expiresAt: dayjs().add(7, "days").toDate(),
          })
          .returning()
          .then((results) => results[0])
          .then(async (invite) => {
            return {
              ...invite,
              inviter: await getUser(invite.inviterId.toString()),
            };
          }),
      );

      if (!newInvite)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create invite",
        );

      const editSessionId = generateInviteCode();

      const payload = {
        ...newInvite,
        editSessionId,
      };

      res.status(HttpStatusCode.Created).json(payload);

      fireAndForgetAll([
        {
          label: "cache:set:inviteEdit",
          run: () =>
            setCache("inviteEdit", `${code}:${editSessionId}`, {
              inviterId: newInvite.inviterId,
            }),
          meta: { code, spaceId },
        },
        {
          label: "cache:invalidate:invites",
          run: () => invalidateCache("invites", spaceId),
          meta: { spaceId },
        },
        {
          label: "cache:set:invite",
          run: () => setCache("invite", code, newInvite),
          meta: { code },
        },
        {
          label: "event:InviteCreate",
          run: () =>
            emitEvent({
              event: "InviteCreate",
              space_id: space.id,
              channel_id: channelId,
              data: newInvite,
            }),
          meta: { code, spaceId, channelId: String(channelId) },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async keepAlive(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { code } = validateInviteParamsCode
        .pick({
          code: true,
        })
        .parse(req.params);

      const invite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          where: eq(invitesTable.code, code),
        }),
      );
      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      const sessionId = req.header("x-invite-edit-session");
      if (!sessionId)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Missing edit session",
        );

      const sessionKey = `${code}:${sessionId}`;
      const session = await getCache("inviteEdit", sessionKey);

      if (!session || BigInt(session.inviterId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Edit session expired",
        );

      await setCache("inviteEdit", sessionKey, {
        inviterId: session.inviterId,
      });

      return res.status(HttpStatusCode.Success).json({
        success: true,
      });
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId, code } = validateInviteParamsCode.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      let invite = await getCache("invite", code);
      if (!invite)
        invite = await execNormalized<APIInvite>(
          db.query.invitesTable.findFirst({
            where: and(
              eq(invitesTable.code, code),
              eq(invitesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );

      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      let canModerate = false;
      if (invite.channelId) {
        try {
          await requireChannelPermissions({
            channelId: invite.channelId,
            userId: user.id,
            needed: ["CreateInvites"],
          });

          canModerate = true;
        } catch {
          canModerate = false;
        }
      }

      const isInviter = BigInt(invite.inviterId) === BigInt(user.id);

      if (!canModerate) {
        if (!isInviter)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "Missing permission",
          );

        const sessionId = req.header("x-invite-edit-session");
        if (!sessionId)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "Edit session expired",
          );

        const session = await getCache(
          "inviteEdit",
          `${invite.code}:${sessionId}`,
        );
        if (!session || BigInt(session.inviterId) !== BigInt(user.id))
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "Edit session expired",
          );

        await setCache("inviteEdit", `${invite.code}:${sessionId}`, {
          inviterId: session.inviterId,
        });
      }

      const { maxUses, expiresAt } = validateInviteBodyPatch.parse(req.body);

      const neverExpires = expiresAt == null;

      invite = await execNormalized<APIInvite | null>(
        db
          .update(invitesTable)
          .set({
            maxUses: maxUses ?? invite.maxUses,
            expiresAt: neverExpires
              ? null
              : dayjs().add(expiresAt, "seconds").toDate(),
          })
          .where(
            and(
              eq(invitesTable.code, code),
              eq(invitesTable.spaceId, BigInt(spaceId)),
            ),
          )
          .returning()
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!invite)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update invite",
        );

      if (invite.uses > invite.maxUses && invite.maxUses !== 0) {
        await db
          .delete(invitesTable)
          .where(
            and(
              eq(invitesTable.code, code),
              eq(invitesTable.spaceId, BigInt(spaceId)),
            ),
          );

        res.status(HttpStatusCode.Success).json(invite);

        fireAndForgetAll([
          {
            label: "cache:delete:invite",
            run: () => deleteCache("invite", code),
            meta: { code },
          },
          {
            label: "cache:invalidate:invites",
            run: () => invalidateCache("invites", spaceId),
            meta: { spaceId },
          },
          {
            label: "event:InviteDelete",
            run: () =>
              emitEvent({
                event: "InviteDelete",
                space_id: space.id,
                channel_id: invite.channelId,
                data: invite,
              }),
            meta: { code, spaceId },
          },
        ]);

        return;
      }

      res.status(HttpStatusCode.Success).json(invite);

      fireAndForgetAll([
        {
          label: "cache:invalidate:invites",
          run: () => invalidateCache("invites", spaceId),
          meta: { spaceId },
        },
        {
          label: "cache:set:invite",
          run: () => setCache("invite", code, invite),
          meta: { code },
        },
        {
          label: "event:InviteUpdate",
          run: () =>
            emitEvent({
              event: "InviteUpdate",
              space_id: space.id,
              channel_id: invite.channelId,
              data: invite,
            }),
          meta: { code, spaceId },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId, code } = validateInviteParamsCode.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      let invite = await getCache("invite", code);
      if (!invite)
        invite = await execNormalized<APIInvite>(
          db.query.invitesTable.findFirst({
            where: and(
              eq(invitesTable.code, code),
              eq(invitesTable.spaceId, BigInt(spaceId)),
            ),
          }),
        );

      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      let canModerate = false;
      if (invite.channelId) {
        try {
          await requireChannelPermissions({
            channelId: invite.channelId,
            userId: user.id,
            needed: ["CreateInvites"],
          });

          canModerate = true;
        } catch {
          canModerate = false;
        }
      }

      if (!canModerate) {
        try {
          await requireSpacePermissions({
            spaceId,
            userId: user.id,
            needed: ["ManageChannels"],
          });

          canModerate = true;
        } catch {
          canModerate = false;
        }
      }

      const isInviter = BigInt(invite.inviterId) === BigInt(user.id);

      if (!canModerate && !isInviter)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Missing permission",
        );

      await db
        .delete(invitesTable)
        .where(
          and(
            eq(invitesTable.code, code),
            eq(invitesTable.spaceId, BigInt(spaceId)),
          ),
        );

      res.status(HttpStatusCode.Success).json({
        code,
        spaceId,
      });

      fireAndForgetAll([
        {
          label: "event:InviteDelete",
          run: () =>
            emitEvent({
              event: "InviteDelete",
              space_id: space.id,
              data: {
                code,
                spaceId,
              },
            }),
          meta: { code, spaceId },
        },
        {
          label: "cache:invalidate:invites",
          run: () => invalidateCache("invites", spaceId),
          meta: { spaceId },
        },
        {
          label: "cache:delete:invite",
          run: () => deleteCache("invite", code),
          meta: { code },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async deleteAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateInviteParamsGet.parse(req.params);

      const space = await getSpace(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      await requireSpacePermissions({
        spaceId: space.id,
        userId: user.id,
        needed: ["ManageChannels"],
      });

      const existingInvites = await execNormalizedMany<APIInvite>(
        db.query.invitesTable.findMany({
          columns: { code: true },
          where: eq(invitesTable.spaceId, BigInt(spaceId)),
        }),
      );

      await db
        .delete(invitesTable)
        .where(eq(invitesTable.spaceId, BigInt(spaceId)));

      res.status(HttpStatusCode.Success).json({
        success: true,
      });

      fireAndForgetAll([
        {
          label: "cache:invalidate:invites",
          run: () => invalidateCache("invites", spaceId),
          meta: { spaceId },
        },
        ...existingInvites.map((inv) => ({
          label: "cache:delete:invite",
          run: () => deleteCache("invite", inv.code),
          meta: { code: inv.code, spaceId },
        })),
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async getFriendInvite(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      const invite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          with: {
            user: true,
            inviter: true,
          },
          where: and(
            eq(invitesTable.type, InviteType.Friend),
            eq(invitesTable.userId, BigInt(user.id)),
          ),
        }),
      );

      if (
        invite &&
        invite.expiresAt &&
        dayjs().isAfter(dayjs(invite.expiresAt))
      ) {
        await db
          .delete(invitesTable)
          .where(eq(invitesTable.code, invite.code));
        await deleteCache("invite", invite.code);

        return res.status(HttpStatusCode.Success).json(null);
      }

      return res.status(HttpStatusCode.Success).json(invite ?? null);
    } catch (err) {
      next(err);
    }
  }

  static async createFriendInvite(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { user } = req;

      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      requireNotRestricted(user);

      const existing = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          with: {
            user: true,
            inviter: true,
          },
          where: and(
            eq(invitesTable.type, InviteType.Friend),
            eq(invitesTable.userId, BigInt(user.id)),
          ),
        }),
      );

      if (
        existing &&
        (!existing.expiresAt || dayjs().isBefore(dayjs(existing.expiresAt)))
      ) {
        return res.status(HttpStatusCode.Success).json(existing);
      }

      const code = generateInviteCode();

      const invite = await execNormalized<APIInvite>(
        db
          .insert(invitesTable)
          .values({
            code,
            type: InviteType.Friend,
            userId: BigInt(user.id),
            inviterId: BigInt(user.id),
            expiresAt: dayjs().add(7, "days").toDate(),
          })
          .returning()
          .then((results) => results[0]),
      );

      if (!invite)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create friend invite",
        );

      const hydrated = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          with: {
            user: true,
            inviter: true,
          },
          where: eq(invitesTable.code, invite.code),
        }),
      );

      if (!hydrated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create friend invite",
        );

      await setCache("invite", code, hydrated);

      return res.status(HttpStatusCode.Created).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async acceptFriend(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

      requireNotRestricted(user);

      const { code } = validateInviteCodeParam.parse(req.params);

      const invite = await execNormalized<APIInvite>(
        db.query.invitesTable.findFirst({
          with: {
            user: true,
          },
          where: and(
            eq(invitesTable.code, code),
            eq(invitesTable.type, InviteType.Friend),
          ),
        }),
      );

      if (!invite)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      if (invite.expiresAt && dayjs().isAfter(dayjs(invite.expiresAt))) {
        await db.delete(invitesTable).where(eq(invitesTable.code, code));
        await deleteCache("invite", code);
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");
      }

      const targetUserId = invite.userId ?? invite.inviterId;
      if (!targetUserId)
        throw new HttpException(HttpStatusCode.NotFound, "Invite not found");

      if (BigInt(targetUserId) === BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot add yourself",
        );

      const targetUser = await getUser(targetUserId.toString(), true);
      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const theirRow = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(targetUser.id)),
          eq(relationshipsTable.otherUserId, BigInt(user.id)),
        ),
      });

      if (theirRow?.type === RelationshipType.Blocked)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const myRow = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(user.id)),
          eq(relationshipsTable.otherUserId, BigInt(targetUser.id)),
        ),
      });

      let relationship: APIRelationship;

      if (myRow) {
        if (myRow.type === RelationshipType.Blocked)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You cannot send a friend request to this user",
          );

        if (myRow.type === RelationshipType.Friend) {
          relationship = await execNormalized<APIRelationship>(
            Promise.resolve(myRow),
          );
        } else if (myRow.type === RelationshipType.OutgoingRequest) {
          throw new HttpException(
            HttpStatusCode.Conflict,
            "You have already sent a friend request to this user",
          );
        } else if (myRow.type === RelationshipType.IncomingRequest) {
          const updatedMine = await execNormalized<APIRelationship | null>(
            db
              .update(relationshipsTable)
              .set({ type: RelationshipType.Friend, updatedAt: new Date() })
              .where(eq(relationshipsTable.id, myRow.id))
              .returning()
              .then((res) => (res.length ? res[0] : null)),
          );

          if (!updatedMine)
            throw new HttpException(
              HttpStatusCode.InternalServerError,
              "Failed to accept relationship",
            );

          relationship = updatedMine;

          if (theirRow) {
            const updatedTheirs = await execNormalized<APIRelationship | null>(
              db
                .update(relationshipsTable)
                .set({ type: RelationshipType.Friend, updatedAt: new Date() })
                .where(eq(relationshipsTable.id, theirRow.id))
                .returning()
                .then((res) => (res.length ? res[0] : null)),
            );

            if (updatedTheirs) {
              fireAndForgetAll([
                {
                  label: "event:RelationshipUpdate:other",
                  run: () =>
                    emitEvent({
                      event: "RelationshipUpdate",
                      user_id: targetUser.id,
                      data: updatedTheirs,
                    }),
                },
              ]);
            }
          }

          fireAndForgetAll([
            {
              label: "event:RelationshipUpdate:self",
              run: () =>
                emitEvent({
                  event: "RelationshipUpdate",
                  user_id: user.id,
                  data: updatedMine,
                }),
            },
          ]);
        } else {
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to accept relationship",
          );
        }
      } else {
        const myCreated = await execNormalized<APIRelationship | null>(
          db
            .insert(relationshipsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              userId: BigInt(user.id),
              otherUserId: BigInt(targetUser.id),
              type: RelationshipType.OutgoingRequest,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!myCreated)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create relationship",
          );

        relationship = myCreated;

        const theirCreated = await execNormalized<APIRelationship | null>(
          db
            .insert(relationshipsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              userId: BigInt(targetUser.id),
              otherUserId: BigInt(user.id),
              type: RelationshipType.IncomingRequest,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        fireAndForgetAll([
          {
            label: "event:RelationshipCreate:self",
            run: () =>
              emitEvent({
                event: "RelationshipCreate",
                user_id: user.id,
                data: myCreated,
              }),
          },
          {
            label: "event:RelationshipCreate:other",
            run: () =>
              emitEvent({
                event: "RelationshipCreate",
                user_id: targetUser.id,
                data: theirCreated,
              }),
          },
        ]);
      }

      if (invite.maxUses > 0 && invite.uses + 1 >= invite.maxUses) {
        await db.delete(invitesTable).where(eq(invitesTable.code, code));
        await deleteCache("invite", code);
      } else {
        await db
          .update(invitesTable)
          .set({ uses: invite.uses + 1 })
          .where(eq(invitesTable.code, code));
      }

      return res.status(HttpStatusCode.Success).json(relationship);
    } catch (err) {
      next(err);
    }
  }
}
