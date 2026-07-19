import { deleteCache, invalidateCache, setCache } from "@mutualzz/cache";
import { channelRecipientsTable, channelsTable, db } from "@mutualzz/database";
import type { APIChannel } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  bucketName,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  generateHash,
  getChannel,
  getSpaceHydrated,
  requireChannelPermissions,
  requireSpacePermissions,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import {
  imageFileValidator,
  validateChannelBodyCreate,
  validateChannelBodyUpdate,
  validateChannelBulkBodyPatch,
  validateChannelParamsDelete,
  validateChannelParamsGet,
  validateChannelParamsUpdate,
  validateChannelQueryDelete,
} from "@mutualzz/validators";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, } from "@aws-sdk/client-s3";
import { BitField, channelFlags } from "@mutualzz/bitfield";
import { z } from "zod";
import { VoiceStateService } from "@mutualzz/gateway";

export default class ChannelsController {
  static async getOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsGet.parse(req.params);

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.spaceId)
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ViewChannel"],
        });

      if (channel.recipientIds && !channel.recipientIds.includes(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You do not have permission to view this channel",
        );

      res.status(HttpStatusCode.Success).json(channel);
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { name, parentId, spaceId, ...rest } =
        validateChannelBodyCreate.parse(req.body);

      const type = parseInt(rest.type);

      switch (type) {
        case ChannelType.Text:
        case ChannelType.Voice:
        case ChannelType.Category:
          break;
        default:
          throw new HttpException(
            HttpStatusCode.BadRequest,
            "Invalid channel type",
            [
              {
                path: "type",
                message: "Invalid channel type",
              },
            ],
          );
      }

      const space = await getSpaceHydrated(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      if (parentId)
        await requireChannelPermissions({
          userId: user.id,
          channelId: parentId,
          needed: ["ManageChannels"],
        });
      else
        await requireSpacePermissions({
          spaceId,
          userId: user.id,
          needed: ["ManageChannels"],
        });

      const iconFile = imageFileValidator.optional().parse(req.file);

      const flags = BitField.fromBits(channelFlags, 0n);

      const channelValues: typeof channelsTable.$inferInsert = {
        id: BigInt(Snowflake.generate()),
        type,
        spaceId: BigInt(space.id),
        name,
        parentId: parentId == null ? null : BigInt(parentId),
      };

      if (iconFile) {
        const isGif = iconFile.mimetype === "image/gif";
        let buffer: Buffer | Uint8Array = iconFile.buffer;

        let iconSharp: sharp.Sharp;
        if (isGif) {
          iconSharp = sharp(buffer, {
            animated: true,
          });

          if (req.body.crop) {
            const { x, y, width, height } = JSON.parse(req.body.crop);
            iconSharp = iconSharp.extract({
              left: x,
              top: y,
              width,
              height,
            });

            buffer = await iconSharp.toBuffer();
          }
        }

        if (req.body.rounded === "true") flags.add("RoundedIcon");

        const iconHash = generateHash(
          buffer,
          iconFile.mimetype.includes("gif"),
        );

        let existingIcon = null;
        const storedExt = isGif ? "gif" : "png";

        try {
          const { Body } = await s3Client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: `icons/channels/${channelValues.id}/${iconHash}.${storedExt}`,
            }),
          );

          existingIcon = Body;
        } catch {
          // Ignore
        }

        if (!existingIcon) {
          await s3Client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Body: buffer,
              Key: `icons/channels/${channelValues.id}/${iconHash}.${storedExt}`,
              ContentType: isGif ? "image/gif" : "image/png",
            }),
          );
        }

        channelValues.icon = iconHash;
      }

      const created = await execNormalized<APIChannel | null>(
        db.transaction(async (tx) => {
          const lockKey = `${space.id}:${parentId ?? "root"}`;
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
          );

          const parentWhere =
            parentId == null
              ? isNull(channelsTable.parentId)
              : eq(channelsTable.parentId, BigInt(parentId));

          const maxPositionRow = await tx
            .select({ maxPos: max(channelsTable.position) })
            .from(channelsTable)
            .where(
              and(eq(channelsTable.spaceId, BigInt(space.id)), parentWhere),
            )
            .then((res) => (res.length ? res[0] : null));

          const positionBase = maxPositionRow?.maxPos ?? null;

          channelValues.position = (positionBase ?? -1) + 1;
          channelValues.flags = flags.bits;

          return await tx
            .insert(channelsTable)
            .values(channelValues)
            .returning()
            .then((res) => (res.length ? res[0] : null));
        }),
      );

      const channel = await (async () => {
        if (!created) return null;
        return created.parentId
          ? {
              ...created,
              parent: await getChannel(created.parentId),
            }
          : created;
      })();

      if (!channel)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create channel",
        );

      res.status(HttpStatusCode.Created).json(channel);

      fireAndForgetAll([
        {
          label: "event:ChannelCreate",
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              space_id: channel.spaceId,
              data: channel,
            }),
        },
        {
          label: "cache:set:channel",
          run: () => setCache("channel", channel.id, channel),
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

      const { channelId } = validateChannelParamsUpdate.parse(req.params);

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type === ChannelType.DM)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You cannot update DM channels",
        );

      if (channel.type === ChannelType.GroupDM) {
        const recipient = await db.query.channelRecipientsTable.findFirst({
          where: and(
            eq(channelRecipientsTable.channelId, BigInt(channelId)),
            eq(channelRecipientsTable.userId, BigInt(user.id)),
          ),
        });

        if (!recipient)
          throw new HttpException(
            HttpStatusCode.Forbidden,
            "You are not a participant of this group DM",
          );

        const iconFile = imageFileValidator.optional().parse(req.file);

        const { name } = validateChannelBodyUpdate
          .pick({ name: true })
          .parse(req.body);

        let icon = channel.icon;
        const flags = BitField.fromBits(channelFlags, BigInt(channel.flags));

        if (req.body.removeIcon === "true") {
          icon = null;
          flags.remove("RoundedIcon");
        } else if (iconFile) {
          const isGif = iconFile.mimetype === "image/gif";
          let buffer: Buffer | Uint8Array = iconFile.buffer;

          if (isGif) {
            let iconSharp = sharp(buffer, { animated: true });

            if (req.body.crop) {
              const { x, y, width, height } = JSON.parse(req.body.crop);
              iconSharp = iconSharp.extract({ left: x, top: y, width, height });
              buffer = await iconSharp.toBuffer();
            }
          }

          if (req.body.rounded === "true") flags.add("RoundedIcon");

          const iconHash = generateHash(
            buffer,
            iconFile.mimetype.includes("gif"),
          );
          const storedExt = isGif ? "gif" : "png";

          let existingIcon = null;
          try {
            const { Body } = await s3Client.send(
              new GetObjectCommand({
                Bucket: bucketName,
                Key: `icons/channels/${channel.id}/${iconHash}.${storedExt}`,
              }),
            );
            existingIcon = Body;
          } catch {
            // ignore
          }

          if (!existingIcon) {
            await s3Client.send(
              new PutObjectCommand({
                Bucket: bucketName,
                Body: buffer,
                Key: `icons/channels/${channel.id}/${iconHash}.${storedExt}`,
                ContentType: isGif ? "image/gif" : "image/png",
              }),
            );
          }

          icon = iconHash;
        }

        const updatedChannel = await execNormalized<APIChannel | null>(
          db
            .update(channelsTable)
            .set({
              name: name ?? channel.name,
              icon,
              flags: flags.bits,
            })
            .where(eq(channelsTable.id, BigInt(channel.id)))
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!updatedChannel)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to update group DM",
          );

        res.status(HttpStatusCode.Success).json(updatedChannel);

        fireAndForgetAll([
          {
            label: "event:ChannelUpdate",
            run: () =>
              emitEvent({
                event: "ChannelUpdate",
                channel_id: channel.id,
                data: updatedChannel,
              }),
          },
          {
            label: "cache:set:channel",
            run: () => setCache("channel", updatedChannel.id, updatedChannel),
          },
        ]);

        return;
      }

      if (channel.spaceId)
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ManageChannels"],
        });

      const { name, topic, nsfw, parentId, position } =
        validateChannelBodyUpdate.parse(req.body);

      const newParentId: bigint | null | undefined =
        parentId === undefined
          ? channel.parentId
            ? BigInt(channel.parentId)
            : null
          : parentId === null
            ? null
            : BigInt(parentId);

      const updatedChannel = await execNormalized<APIChannel | null>(
        db
          .update(channelsTable)
          .set({
            name: name ?? channel.name,
            topic: topic ?? channel.topic,
            nsfw: nsfw ?? channel.nsfw,
            parentId: newParentId,
            position: position ?? channel.position,
          })
          .where(eq(channelsTable.id, BigInt(channel.id)))
          .returning()
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!updatedChannel)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update channel",
        );

      res.status(HttpStatusCode.Success).json(updatedChannel);

      fireAndForgetAll([
        {
          label: "event:ChannelUpdate",
          run: () =>
            emitEvent({
              event: "ChannelUpdate",
              channel_id: channel.id,
              data: updatedChannel,
            }),
        },
        {
          label: "cache:update:channel",
          run: () => setCache("channel", updatedChannel.id, updatedChannel),
        },
        ...(updatedChannel.spaceId
          ? [
              {
                label: "cache:invalidate:spaceHydrated",
                run: () =>
                  invalidateCache("spaceHydrated", updatedChannel.spaceId!),
              },
            ]
          : []),
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async updateBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId, channels } = validateChannelBulkBodyPatch.parse(
        req.body,
      );

      const space = await getSpaceHydrated(spaceId);
      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      await requireSpacePermissions({
        spaceId: space.id,
        userId: user.id,
        needed: ["ManageChannels"],
      });

      const newChannels: APIChannel[] = await db.transaction(async (tx) => {
        const updated: APIChannel[] = [];

        const resolved: {
          chBody: (typeof channels)[number];
          channel: NonNullable<Awaited<ReturnType<typeof getChannel>>>;
        }[] = [];

        for (const chBody of channels) {
          const channel = await getChannel(chBody.id);
          if (!channel)
            throw new HttpException(
              HttpStatusCode.NotFound,
              `Channel with ID ${chBody.id} not found`,
            );

          if (!channel.spaceId || channel.spaceId !== spaceId)
            throw new HttpException(
              HttpStatusCode.BadRequest,
              `Channel ${chBody.id} does not belong to space ${spaceId}`,
            );

          resolved.push({ chBody, channel });
        }

        for (let i = 0; i < resolved.length; i++) {
          const entry = resolved[i];
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (!entry)
            throw new HttpException(
              HttpStatusCode.InternalServerError,
              `Missing resolved channel at index ${i}`,
            );

          const staged = await tx
            .update(channelsTable)
            .set({
              position: -32768 + i,
            })
            .where(eq(channelsTable.id, BigInt(entry.channel.id)))
            .returning()
            .then((res) => (res.length ? res[0] : null));

          if (!staged)
            throw new HttpException(
              HttpStatusCode.InternalServerError,
              `Failed to stage channel with ID ${entry.channel.id}`,
            );
        }

        for (const { chBody, channel } of resolved) {
          const nextParentId: bigint | null | undefined =
            chBody.parentId === undefined
              ? undefined
              : chBody.parentId === null
                ? null
                : BigInt(chBody.parentId);

          const newChannel = await execNormalized<APIChannel | null>(
            tx
              .update(channelsTable)
              .set({
                name: chBody.name ?? channel.name,
                topic: chBody.topic ?? channel.topic,
                nsfw: chBody.nsfw ?? channel.nsfw,
                parentId: nextParentId,
                position: chBody.position ?? channel.position,
              })
              .where(eq(channelsTable.id, BigInt(channel.id)))
              .returning()
              .then((res) => (res.length ? res[0] : null)),
          );

          if (!newChannel)
            throw new HttpException(
              HttpStatusCode.InternalServerError,
              `Failed to update channel with ID ${chBody.id}`,
            );

          updated.push(newChannel);
        }

        return updated;
      });

      res.status(HttpStatusCode.Success).json(newChannels);

      fireAndForgetAll([
        {
          label: "event:ChannelUpdateBulk",
          run: () =>
            emitEvent({
              event: "ChannelUpdateBulk",
              space_id: spaceId,
              data: newChannels,
            }),
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

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsDelete.parse(req.params);
      const { parentOnly } = validateChannelQueryDelete.parse(req.query);

      const channel = await getChannel(channelId);

      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.spaceId) {
        await requireChannelPermissions({
          channelId: channel.id,
          userId: user.id,
          needed: ["ManageChannels"],
        });
      } else if (
        channel.ownerId &&
        BigInt(channel.ownerId) !== BigInt(user.id)
      ) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You do not have permission to delete this channel",
        );
      }

      let deletedChannels: APIChannel[] = [];

      if (parentOnly === false && channel.type === ChannelType.Category)
        deletedChannels = await execNormalizedMany<APIChannel>(
          db
            .delete(channelsTable)
            .where(eq(channelsTable.parentId, BigInt(channel.id)))
            .returning(),
        );

      const deletedParent = await execNormalized<APIChannel | null>(
        db
          .delete(channelsTable)
          .where(eq(channelsTable.id, BigInt(channel.id)))
          .returning()
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!deletedParent)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to delete channel",
        );

      deletedChannels.push(deletedParent);

      if (parentOnly === false && channel.type === ChannelType.Category) {
        res.status(HttpStatusCode.Success).json(
          deletedChannels.map((ch) => ({
            id: ch.id,
            spaceId: ch.spaceId,
          })),
        );

        fireAndForgetAll([
          ...deletedChannels
            .filter((ch) => ch.type === ChannelType.Voice && ch.spaceId)
            .map((ch) => ({
              label: `voice:kickChannelFromVoice:${ch.id}`,
              run: () =>
                VoiceStateService.kickChannelFromVoice(
                  ch.spaceId!,
                  ch.id,
                  "Voice channel deleted",
                ),
            })),
          {
            label: "event:BulkChannelDelete",
            run: () =>
              emitEvent({
                event: "ChannelDeleteBulk",
                space_id: channel.spaceId,
                data: deletedChannels.map((ch) => ({
                  id: ch.id,
                  spaceId: ch.spaceId,
                })),
              }),
          },
          ...deletedChannels.map((ch) => ({
            label: `cache:delete:channel:${ch.id}`,
            run: () => deleteCache("channel", ch.id),
          })),
          ...(channel.spaceId
            ? [
                {
                  label: `cache:invalidate:spaceHydrated:${channel.spaceId}`,
                  run: () => invalidateCache("spaceHydrated", channel.spaceId!),
                },
              ]
            : []),
        ]);

        return;
      }

      res.status(HttpStatusCode.Success).json({
        id: channel.id,
        spaceId: channel.spaceId,
      });

      fireAndForgetAll([
        ...(channel.type === ChannelType.Voice && channel.spaceId
          ? [
              {
                label: "voice:kickChannelFromVoice",
                run: () =>
                  VoiceStateService.kickChannelFromVoice(
                    channel.spaceId!,
                    channel.id,
                    "Voice channel deleted",
                  ),
              },
            ]
          : []),
        {
          label: "event:ChannelDelete",
          run: () =>
            emitEvent({
              event: "ChannelDelete",
              channel_id: channel.id,
              data: {
                id: channel.id,
                spaceId: channel.spaceId,
              },
            }),
        },
        {
          label: "cache:delete:channel",
          run: () => deleteCache("channel", channel.id),
        },
        ...(channel.spaceId
          ? [
              {
                label: "cache:invalidate:spaceHydrated",
                run: () => invalidateCache("spaceHydrated", channel.spaceId!),
              },
            ]
          : []),
      ]);

      if (channel.icon) {
        const ext = channel.icon.startsWith("a_") ? "gif" : "png";
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: `icons/channels/${channel.id}/${channel.icon}.${ext}`,
            }),
          );
        } catch {
          // ignore since it might be already deleted
        }
      }
    } catch (err) {
      next(err);
    }
  }

  static async typing(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = z
        .object({
          channelId: z.string("Invalid Channel ID"),
        })
        .parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      res.sendStatus(HttpStatusCode.NoContent);

      fireAndForgetAll([
        {
          label: "event:TypingStart",
          run: () =>
            emitEvent({
              event: "TypingStart",
              channel_id: channelId,
              data: {
                channelId,
                userId: user.id,
              },
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
