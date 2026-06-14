import { channelMemberOverwritesTable, channelRoleOverwritesTable, db, } from "@mutualzz/database";
import type { APIChannelPermissionOverwrite } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { emitEvent, execNormalized, fireAndForgetAll, getChannel, requireChannelPermissions, } from "@mutualzz/util";
import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { deleteCache, invalidateCache, setCache } from "@mutualzz/cache";

const validateOverwriteParams = z.object({
  channelId: z.string("Invalid Channel ID"),
  targetId: z.string("Invalid Target ID"),
});

const validateOverwriteBody = z.object({
  allow: z.union([z.string(), z.bigint()]).optional(),
  deny: z.union([z.string(), z.bigint()]).optional(),
});

export default class ChannelPermissionOverwritesController {
  static async add(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId, targetId } = validateOverwriteParams.parse(req.params);

      const { type } = z
        .object({ type: z.enum(["role", "member"]).default("role") })
        .parse(req.query);

      const { allow, deny } = validateOverwriteBody.parse(req.body);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (!channel.spaceId)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Permission overwrites can only be set on space channels",
        );

      await requireChannelPermissions({
        channelId,
        userId: user.id,
        needed: ["ManageRoles"],
      });

      const allowBits = BigInt(allow ?? 0);
      const denyBits = BigInt(deny ?? 0);

      if (type === "role") {
        const table = channelRoleOverwritesTable;
        const where = and(
          eq(table.channelId, BigInt(channelId)),
          eq(table.roleId, BigInt(targetId)),
        );

        const updated =
          await execNormalized<APIChannelPermissionOverwrite | null>(
            db
              .update(table)
              .set({ allow: allowBits, deny: denyBits, updatedAt: new Date() })
              .where(where)
              .returning()
              .then((rows) => rows[0] ?? null),
          );

        if (!updated) {
          await execNormalized<APIChannelPermissionOverwrite | null>(
            db
              .insert(table)
              .values({
                channelId: BigInt(channelId),
                spaceId: BigInt(channel.spaceId),
                roleId: BigInt(targetId),
                allow: allowBits,
                deny: denyBits,
              })
              .returning()
              .then((rows) => rows[0] ?? null),
          );
        }
      } else {
        const table = channelMemberOverwritesTable;
        const where = and(
          eq(table.channelId, BigInt(channelId)),
          eq(table.userId, BigInt(targetId)),
        );

        const updated =
          await execNormalized<APIChannelPermissionOverwrite | null>(
            db
              .update(table)
              .set({ allow: allowBits, deny: denyBits, updatedAt: new Date() })
              .where(where)
              .returning()
              .then((rows) => rows[0] ?? null),
          );

        if (!updated) {
          await execNormalized<APIChannelPermissionOverwrite | null>(
            db
              .insert(table)
              .values({
                channelId: BigInt(channelId),
                spaceId: BigInt(channel.spaceId),
                userId: BigInt(targetId),
                allow: allowBits,
                deny: denyBits,
              })
              .returning()
              .then((rows) => rows[0] ?? null),
          );
        }
      }

      await deleteCache("channel", channelId);

      const updatedChannel = await getChannel(channelId);
      if (!updatedChannel)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to re-fetch channel after overwrite upsert",
        );

      res.status(HttpStatusCode.Success).json(updatedChannel);

      fireAndForgetAll([
        {
          label: "event:ChannelUpdate",
          run: () =>
            emitEvent({
              event: "ChannelUpdate",
              channel_id: updatedChannel.id,
              data: updatedChannel,
            }),
        },
        {
          label: "cache:set:channel",
          run: () => setCache("channel", updatedChannel.id, updatedChannel),
        },
        {
          label: "cache:invalidate:spaceHydrated",
          run: () => invalidateCache("spaceHydrated", channel.spaceId!),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId, targetId } = validateOverwriteParams.parse(req.params);

      const { type } = z
        .object({ type: z.enum(["role", "member"]).default("role") })
        .parse(req.query);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (!channel.spaceId)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Permission overwrites can only be removed from space channels",
        );

      await requireChannelPermissions({
        channelId,
        userId: user.id,
        needed: ["ManageRoles"],
      });

      let deleted: APIChannelPermissionOverwrite | null;

      if (type === "role") {
        deleted = await execNormalized<APIChannelPermissionOverwrite | null>(
          db
            .delete(channelRoleOverwritesTable)
            .where(
              and(
                eq(channelRoleOverwritesTable.channelId, BigInt(channelId)),
                eq(channelRoleOverwritesTable.roleId, BigInt(targetId)),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null),
        );
      } else {
        deleted = await execNormalized<APIChannelPermissionOverwrite | null>(
          db
            .delete(channelMemberOverwritesTable)
            .where(
              and(
                eq(channelMemberOverwritesTable.channelId, BigInt(channelId)),
                eq(channelMemberOverwritesTable.userId, BigInt(targetId)),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null),
        );
      }

      if (!deleted)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Permission overwrite not found",
        );

      await deleteCache("channel", channelId);

      const updatedChannel = await getChannel(channelId);
      if (!updatedChannel)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to re-fetch channel after overwrite delete",
        );

      res.status(HttpStatusCode.Success).json(updatedChannel);

      fireAndForgetAll([
        {
          label: "event:ChannelUpdate",
          run: () =>
            emitEvent({
              event: "ChannelUpdate",
              channel_id: updatedChannel.id,
              data: updatedChannel,
            }),
        },
        {
          label: "cache:set:channel",
          run: () => setCache("channel", updatedChannel.id, updatedChannel),
        },
        {
          label: "cache:invalidate:spaceHydrated",
          run: () => invalidateCache("spaceHydrated", channel.spaceId!),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
