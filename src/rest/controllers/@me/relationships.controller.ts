import {
  type APIRelationship,
  HttpException,
  HttpStatusCode,
  RelationshipType,
} from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";
import {
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  resolveUserIdentifier,
  Snowflake,
} from "@mutualzz/util";
import { db, relationshipsTable } from "@mutualzz/database";
import { and, eq } from "drizzle-orm";
import { validateRelationshipRequest } from "@mutualzz/validators";

export default class RelationshipsController {
  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const relationships = await execNormalizedMany<APIRelationship>(
        db.query.relationshipsTable.findMany({
          where: eq(relationshipsTable.userId, BigInt(user.id)),
        }),
      );

      res.status(HttpStatusCode.Success).json(relationships);
    } catch (err) {
      next(err);
    }
  }

  static async getIncoming(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const relationships = await execNormalizedMany<APIRelationship>(
        db.query.relationshipsTable.findMany({
          where: and(
            eq(relationshipsTable.userId, BigInt(user.id)),
            eq(relationshipsTable.type, RelationshipType.IncomingRequest),
          ),
        }),
      );

      res.status(HttpStatusCode.Success).json(relationships);
    } catch (err) {
      next(err);
    }
  }

  static async getOutgoing(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const relationships = await execNormalizedMany<APIRelationship>(
        db.query.relationshipsTable.findMany({
          where: and(
            eq(relationshipsTable.userId, BigInt(user.id)),
            eq(relationshipsTable.type, RelationshipType.OutgoingRequest),
          ),
        }),
      );

      res.status(HttpStatusCode.Success).json(relationships);
    } catch (err) {
      next(err);
    }
  }

  static async getBlocked(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const relationships = await execNormalizedMany<APIRelationship>(
        db.query.relationshipsTable.findMany({
          where: and(
            eq(relationshipsTable.userId, BigInt(user.id)),
            eq(relationshipsTable.type, RelationshipType.Blocked),
          ),
        }),
      );

      res.status(HttpStatusCode.Success).json(relationships);
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { identifier: targetIdentifier } =
        validateRelationshipRequest.parse(req.body);

      const targetUser = await resolveUserIdentifier(targetIdentifier);

      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (BigInt(targetUser.id) === BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot add yourself",
        );

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

      if (myRow) {
        if (myRow.type === RelationshipType.Blocked)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You cannot send a friend request to this user",
          );

        if (myRow.type === RelationshipType.Friend) {
          const relationship = await execNormalized<APIRelationship>(
            Promise.resolve(myRow),
          );
          return res.status(HttpStatusCode.Success).json(relationship);
        }

        if (myRow.type === RelationshipType.OutgoingRequest)
          throw new HttpException(
            HttpStatusCode.Conflict,
            "You have already sent a friend request to this user",
          );

        if (myRow.type === RelationshipType.IncomingRequest) {
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

          let updatedTheirs: APIRelationship | null = null;
          if (theirRow)
            updatedTheirs = await execNormalized<APIRelationship | null>(
              db
                .update(relationshipsTable)
                .set({ type: RelationshipType.Friend, updatedAt: new Date() })
                .where(eq(relationshipsTable.id, theirRow.id))
                .returning()
                .then((res) => (res.length ? res[0] : null)),
            );

          res.status(HttpStatusCode.Success).json(updatedMine);

          const events = [
            {
              label: "event:RelationshipUpdate:self",
              run: () =>
                emitEvent({
                  event: "RelationshipUpdate",
                  user_id: user.id,
                  data: updatedMine,
                }),
            },
          ];

          if (updatedTheirs)
            events.push({
              label: "event:RelationshipUpdate:other",
              run: () =>
                emitEvent({
                  event: "RelationshipUpdate",
                  user_id: targetUser.id,
                  data: updatedTheirs,
                }),
            });

          fireAndForgetAll(events);
          return;
        }
      }

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

      res.status(HttpStatusCode.Created).json(myCreated);

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
    } catch (err) {
      next(err);
    }
  }

  static async accept(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { identifier: targetIdentifier } = validateRelationshipRequest.parse(req.params);
      const targetUser = await resolveUserIdentifier(targetIdentifier);
      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const myRow = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(user.id)),
          eq(relationshipsTable.otherUserId, BigInt(targetUser.id)),
        ),
      });

      if (!myRow || myRow.type !== RelationshipType.IncomingRequest)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Relationship not found",
        );

      const theirRow = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(targetUser.id)),
          eq(relationshipsTable.otherUserId, BigInt(user.id)),
        ),
      });

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

      let updatedTheirs: APIRelationship | null = null;
      if (theirRow)
        updatedTheirs = await execNormalized<APIRelationship | null>(
          db
            .update(relationshipsTable)
            .set({ type: RelationshipType.Friend, updatedAt: new Date() })
            .where(eq(relationshipsTable.id, theirRow.id))
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

      res.status(HttpStatusCode.Success).json(updatedMine);

      const events = [
        {
          label: "event:RelationshipUpdate:self",
          run: () =>
            emitEvent({
              event: "RelationshipUpdate",
              user_id: user.id,
              data: updatedMine,
            }),
        },
      ];

      if (updatedTheirs)
        events.push({
          label: "event:RelationshipUpdate:other",
          run: () =>
            emitEvent({
              event: "RelationshipUpdate",
              user_id: targetUser.id,
              data: updatedTheirs,
            }),
        });

      fireAndForgetAll(events);
    } catch (err) {
      next(err);
    }
  }

  static async decline(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { identifier: targetIdentifier } = validateRelationshipRequest.parse(req.params);
      const targetUser = await resolveUserIdentifier(targetIdentifier);
      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const myRow = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(user.id)),
          eq(relationshipsTable.otherUserId, BigInt(targetUser.id)),
        ),
      });

      if (!myRow)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Relationship not found",
        );

      await db
        .delete(relationshipsTable)
        .where(eq(relationshipsTable.id, myRow.id));

      await db
        .delete(relationshipsTable)
        .where(
          and(
            eq(relationshipsTable.userId, BigInt(targetUser.id)),
            eq(relationshipsTable.otherUserId, BigInt(user.id)),
          ),
        );

      res.status(HttpStatusCode.Success).json({ success: true });

      fireAndForgetAll([
        {
          label: "event:RelationshipDelete:self",
          run: () =>
            emitEvent({
              event: "RelationshipDelete",
              user_id: user.id,
              data: { userId: user.id, otherUserId: targetUser.id },
            }),
        },
        {
          label: "event:RelationshipDelete:other",
          run: () =>
            emitEvent({
              event: "RelationshipDelete",
              user_id: targetUser.id,
              data: { userId: targetUser.id, otherUserId: user.id },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async remove(req: Request, res: Response, next: NextFunction) {
    return RelationshipsController.decline(req, res, next);
  }

  static async block(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { identifier: targetIdentifier } = validateRelationshipRequest.parse(req.params);
      const targetUser = await resolveUserIdentifier(targetIdentifier);
      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      if (targetUser.id === user.id)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot block yourself",
        );

      await db
        .delete(relationshipsTable)
        .where(
          and(
            eq(relationshipsTable.userId, BigInt(user.id)),
            eq(relationshipsTable.otherUserId, BigInt(targetUser.id)),
          ),
        );

      await db
        .delete(relationshipsTable)
        .where(
          and(
            eq(relationshipsTable.userId, BigInt(targetUser.id)),
            eq(relationshipsTable.otherUserId, BigInt(user.id)),
          ),
        );

      const created = await execNormalized<APIRelationship | null>(
        db
          .insert(relationshipsTable)
          .values({
            id: BigInt(Snowflake.generate()),
            userId: BigInt(user.id),
            otherUserId: BigInt(targetUser.id),
            type: RelationshipType.Blocked,
          })
          .returning()
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!created)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to block user",
        );

      res.status(HttpStatusCode.Created).json(created);

      fireAndForgetAll([
        {
          label: "event:RelationshipCreate:blocker",
          run: () =>
            emitEvent({
              event: "RelationshipCreate",
              user_id: user.id,
              data: created,
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async unblock(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { identifier: targetIdentifier } = validateRelationshipRequest.parse(req.params);
      const targetUser = await resolveUserIdentifier(targetIdentifier);
      if (!targetUser)
        throw new HttpException(HttpStatusCode.NotFound, "User not found");

      const existing = await db.query.relationshipsTable.findFirst({
        where: and(
          eq(relationshipsTable.userId, BigInt(user.id)),
          eq(relationshipsTable.otherUserId, BigInt(targetUser.id)),
          eq(relationshipsTable.type, RelationshipType.Blocked),
        ),
      });

      if (!existing)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Relationship not found",
        );

      await db
        .delete(relationshipsTable)
        .where(eq(relationshipsTable.id, existing.id));

      res.status(HttpStatusCode.Success).json({ success: true });

      fireAndForgetAll([
        {
          label: "event:RelationshipDelete:blocker",
          run: () =>
            emitEvent({
              event: "RelationshipDelete",
              user_id: user.id,
              data: { userId: user.id, otherUserId: targetUser.id },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
