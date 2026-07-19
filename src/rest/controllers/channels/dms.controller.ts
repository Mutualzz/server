import type { NextFunction, Request, Response } from "express";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  bucketName,
  emitEvent,
  fireAndForgetAll,
  generateHash,
  getChannel,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import { channelRecipientsTable, channelsTable, db, usersTable, } from "@mutualzz/database";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { deleteCache, setCache } from "@mutualzz/cache";
import { imageFileValidator, validateChannelParamsDelete, validateDmChannelCreateBody, } from "@mutualzz/validators";
import { BitField, channelFlags } from "@mutualzz/bitfield";
import sharp from "sharp";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { VoiceStateService } from "../../../gateway/voice/VoiceState.service.ts";
import { CallService } from "../../../gateway/call/Call.service.ts";

export default class DMsController {
  static async createDM(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { recipientId } = validateDmChannelCreateBody.parse(req.body);

      if (recipientId === user.id)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot DM yourself",
        );

      // Check if a DM channel already exists between these two users
      const existing = await db
        .select({ channelId: channelRecipientsTable.channelId })
        .from(channelRecipientsTable)
        .where(
          and(
            eq(channelRecipientsTable.userId, BigInt(user.id)),
            sql`exists (
                        select 1 from ${channelRecipientsTable} cr2
            where cr2."channelId" = ${channelRecipientsTable.channelId}
            and cr2."userId" = ${BigInt(recipientId)}
            )`,
          ),
        )
        .then((res) => (res.length ? res[0] : null));

      if (existing) {
        const recipient = await db.query.channelRecipientsTable.findFirst({
          where: and(
            eq(channelRecipientsTable.channelId, existing.channelId),
            eq(channelRecipientsTable.userId, BigInt(user.id)),
          ),
        });

        const wasClosed = recipient?.closed ?? false;

        // Reopen it for the current user if closed
        await db
          .update(channelRecipientsTable)
          .set({ closed: false })
          .where(
            and(
              eq(channelRecipientsTable.channelId, existing.channelId),
              eq(channelRecipientsTable.userId, BigInt(user.id)),
            ),
          );

        const channel = await getChannel(existing.channelId.toString());
        if (!channel)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to retrieve DM channel",
          );

        res.status(HttpStatusCode.Success).json(channel);

        if (wasClosed) {
          fireAndForgetAll([
            {
              label: "event:ChannelCreate:reopen",
              run: () =>
                emitEvent({
                  event: "ChannelCreate",
                  user_id: user.id,
                  data: channel,
                }),
            },
          ]);
        }

        return;
      }

      const channelId = BigInt(Snowflake.generate());

      const channel = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(channelsTable)
          .values({
            id: channelId,
            type: ChannelType.DM,
            flags: 0n,
            position: 0,
          })
          .returning();

        await tx.insert(channelRecipientsTable).values([
          { channelId, userId: BigInt(user.id) },
          { channelId, userId: BigInt(recipientId) },
        ]);

        return created;
      });

      const hydrated = await getChannel(channel.id.toString());
      if (!hydrated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create DM channel",
        );

      res.status(HttpStatusCode.Created).json(hydrated);

      fireAndForgetAll([
        {
          label: "event:ChannelCreate:sender",
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              user_id: user.id,
              data: hydrated,
            }),
        },
        {
          label: "cache:set:channel",
          run: () => setCache("channel", hydrated.id, hydrated),
        },
      ]);

      fireAndForgetAll([
        {
          label: `event:ChannelCreate:${recipientId}`,
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              user_id: recipientId,
              data: hydrated,
            }),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async createGroupDM(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { recipientIds, name } = z
        .object({
          recipientIds: z
            .union([
              z.string().transform((s) => JSON.parse(s) as string[]),
              z.string().array(),
            ])
            .pipe(z.string().array().min(2)),
          name: z.string().min(1).max(100).optional(),
        })
        .parse(req.body);

      const filteredRecipientIds = [
        ...new Set(recipientIds.filter((id) => id !== user.id)),
      ];

      if (filteredRecipientIds.length > 9)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Group DMs cannot have more than 9 recipients (10 including you)",
        );

      if (filteredRecipientIds.length === 0)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Group DM must include at least one other user",
        );

      const iconFile = imageFileValidator.optional().parse(req.file);

      const channelId = BigInt(Snowflake.generate());

      const flags = BitField.fromBits(channelFlags, 0n);
      let iconHash: string | null = null;

      if (iconFile) {
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

        iconHash = generateHash(buffer, iconFile.mimetype.includes("gif"));
        const storedExt = isGif ? "gif" : "png";

        let existingIcon = null;
        try {
          const { Body } = await s3Client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: `icons/channels/${channelId}/${iconHash}.${storedExt}`,
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
              Key: `icons/channels/${channelId}/${iconHash}.${storedExt}`,
              ContentType: isGif ? "image/gif" : "image/png",
            }),
          );
        }
      }

      const channel = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(channelsTable)
          .values({
            id: channelId,
            type: ChannelType.GroupDM,
            name: name ?? null,
            icon: iconHash,
            flags: flags.bits,
            position: 0,
            ownerId: BigInt(user.id),
          })
          .returning();

        await tx.insert(channelRecipientsTable).values([
          { channelId, userId: BigInt(user.id) },
          ...filteredRecipientIds.map((id) => ({
            channelId,
            userId: BigInt(id),
          })),
        ]);

        return created;
      });

      const hydrated = await getChannel(channel.id.toString());
      if (!hydrated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create group DM channel",
        );

      res.status(HttpStatusCode.Created).json(hydrated);

      fireAndForgetAll([
        {
          label: "event:ChannelCreate:sender",
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              user_id: user.id,
              data: hydrated,
            }),
        },
        {
          label: "cache:set:channel",
          run: () => setCache("channel", hydrated.id, hydrated),
        },
      ]);

      fireAndForgetAll(
        filteredRecipientIds.map((recipientId) => ({
          label: `event:ChannelCreate:${recipientId}`,
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              user_id: recipientId,
              data: hydrated,
            }),
        })),
      );
    } catch (err) {
      next(err);
    }
  }

  static async closeDM(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsDelete.parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type !== ChannelType.DM)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Channel is not a DM channel",
        );

      const recipient = await db.query.channelRecipientsTable.findFirst({
        where: and(
          eq(channelRecipientsTable.channelId, BigInt(channelId)),
          eq(channelRecipientsTable.userId, BigInt(user.id)),
        ),
      });

      if (!recipient)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a recipient of this channel",
        );

      await db
        .update(channelRecipientsTable)
        .set({ closed: true })
        .where(
          and(
            eq(channelRecipientsTable.channelId, BigInt(channelId)),
            eq(channelRecipientsTable.userId, BigInt(user.id)),
          ),
        );

      res.status(HttpStatusCode.Success).json({ id: channelId });

      fireAndForgetAll([
        {
          label: "event:ChannelDelete",
          run: () =>
            emitEvent({
              event: "ChannelDelete",
              user_id: user.id,
              data: { id: channelId },
            }),
        },
        {
          label: "cache:delete:channel",
          run: () => deleteCache("channel", channelId),
        },
        {
          label: "voice+call:closeDM",
          run: async () => {
            await CallService.endCallForChannel(channelId, "dm_closed");
            await VoiceStateService.kickMemberFromVoice(
              null,
              user.id,
              "DM channel closed",
              channelId,
            );
          },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async leaveGroupDM(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsDelete.parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type !== ChannelType.GroupDM)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Channel is not a group DM",
        );

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

      await db
        .delete(channelRecipientsTable)
        .where(
          and(
            eq(channelRecipientsTable.channelId, BigInt(channelId)),
            eq(channelRecipientsTable.userId, BigInt(user.id)),
          ),
        );

      // Transfer ownership or delete channel if empty
      if (channel.ownerId && BigInt(channel.ownerId) === BigInt(user.id)) {
        const nextOwner = await db.query.channelRecipientsTable.findFirst({
          where: eq(channelRecipientsTable.channelId, BigInt(channelId)),
        });

        if (nextOwner) {
          await db
            .update(channelsTable)
            .set({ ownerId: nextOwner.userId })
            .where(eq(channelsTable.id, BigInt(channelId)));
        } else {
          await db
            .delete(channelsTable)
            .where(eq(channelsTable.id, BigInt(channelId)));

          res.status(HttpStatusCode.Success).json({ id: channelId });

          fireAndForgetAll([
            {
              label: "event:ChannelDelete",
              run: () =>
                emitEvent({
                  event: "ChannelDelete",
                  user_id: user.id,
                  data: { id: channelId },
                }),
            },
            {
              label: "cache:delete:channel",
              run: () => deleteCache("channel", channelId),
            },
            {
              label: "voice:kickChannelFromVoice:deleteGroupDM",
              run: () =>
                VoiceStateService.kickChannelFromVoice(
                  null,
                  channelId,
                  "Group DM deleted",
                ),
            },
            {
              label: "call:endCallForChannel:deleteGroupDM",
              run: () => CallService.endCallForChannel(channelId),
            },
          ]);

          return;
        }
      }

      res.status(HttpStatusCode.Success).json({ id: channelId });

      fireAndForgetAll([
        {
          label: "event:ChannelRecipientRemove",
          run: () =>
            emitEvent({
              event: "ChannelRecipientRemove",
              channel_id: channelId,
              data: {
                channelId,
                userId: user.id,
              },
            }),
        },
        {
          label: "event:ChannelDelete:self",
          run: () =>
            emitEvent({
              event: "ChannelDelete",
              user_id: user.id,
              data: { id: channelId },
            }),
        },
        {
          label: "cache:delete:channel",
          run: () => deleteCache("channel", channelId),
        },
        {
          label: "voice+call:leaveGroupDM",
          run: async () => {
            await VoiceStateService.kickMemberFromVoice(
              null,
              user.id,
              "Left group DM",
              channelId,
            );
            await CallService.detachUserFromCall(channelId, user.id);
          },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
  static async deleteGroupDM(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsDelete.parse(req.params);

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type !== ChannelType.GroupDM)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Channel is not a group DM",
        );

      if (!channel.ownerId || BigInt(channel.ownerId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Only the group owner can delete the group",
        );

      const recipients = await db
        .select({ userId: channelRecipientsTable.userId })
        .from(channelRecipientsTable)
        .where(eq(channelRecipientsTable.channelId, BigInt(channelId)));

      await db
        .delete(channelsTable)
        .where(eq(channelsTable.id, BigInt(channelId)));

      res.status(HttpStatusCode.Success).json({ id: channelId });

      fireAndForgetAll([
        {
          label: "cache:delete:channel",
          run: () => deleteCache("channel", channelId),
        },
        {
          label: "voice:kickChannelFromVoice:deleteGroupDM",
          run: () =>
            VoiceStateService.kickChannelFromVoice(
              null,
              channelId,
              "Group DM deleted",
            ),
        },
        {
          label: "call:endCallForChannel:deleteGroupDM",
          run: () => CallService.endCallForChannel(channelId),
        },
        ...recipients.map(({ userId }) => ({
          label: `event:ChannelDelete:${userId}`,
          run: () =>
            emitEvent({
              event: "ChannelDelete",
              user_id: userId.toString(),
              data: { id: channelId },
            }),
        })),
      ]);
    } catch (err) {
      next(err);
    }
  }
  static async addRecipient(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { channelId } = validateChannelParamsDelete.parse(req.params);

      const { recipientId } = z
        .object({ recipientId: z.string() })
        .parse(req.params);

      if (recipientId === user.id)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot add yourself",
        );

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type !== ChannelType.GroupDM)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Channel is not a group DM",
        );

      // Must be a participant to add someone
      const self = await db.query.channelRecipientsTable.findFirst({
        where: and(
          eq(channelRecipientsTable.channelId, BigInt(channelId)),
          eq(channelRecipientsTable.userId, BigInt(user.id)),
        ),
      });

      if (!self)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You are not a participant of this group DM",
        );

      const currentRecipients = await db
        .select({ userId: channelRecipientsTable.userId })
        .from(channelRecipientsTable)
        .where(eq(channelRecipientsTable.channelId, BigInt(channelId)));

      if (currentRecipients.length >= 10)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Group DMs cannot have more than 10 participants",
        );

      const alreadyIn = currentRecipients.some(
        (r) => r.userId === BigInt(recipientId),
      );

      if (alreadyIn)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "User is already in this group DM",
        );

      await db
        .insert(channelRecipientsTable)
        .values({ channelId: BigInt(channelId), userId: BigInt(recipientId) });

      await deleteCache("channel", channelId);

      const fresh = await getChannel(channelId);
      if (!fresh)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to retrieve channel after adding recipient",
        );

      res.status(HttpStatusCode.Success).json({ id: channelId });

      fireAndForgetAll([
        {
          label: "event:ChannelRecipientAdd:channel",
          run: async () => {
            const user = await db.query.usersTable
              .findFirst({ where: eq(usersTable.id, BigInt(recipientId)) })
              .then((r) => r ?? null);

            return emitEvent({
              event: "ChannelRecipientAdd",
              channel_id: channelId,
              data: {
                channelId,
                userId: recipientId,
                user,
              },
            });
          },
        },
        {
          label: "event:ChannelCreate:recipient",
          run: () =>
            emitEvent({
              event: "ChannelCreate",
              user_id: recipientId,
              data: fresh,
            }),
        },
        {
          label: "call:notifyActiveCall:recipient",
          run: () =>
            CallService.notifyUserOfActiveCall(channelId, recipientId),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
  static async removeRecipient(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const { user } = req;

      const { channelId, recipientId } = z
        .object({
          channelId: z.string(),
          recipientId: z.string(),
        })
        .parse(req.params);

      if (recipientId === user.id)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "You cannot remove yourself — use the leave endpoint instead",
        );

      const channel = await getChannel(channelId);
      if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");

      if (channel.type !== ChannelType.GroupDM)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Channel is not a group DM",
        );

      if (!channel.ownerId || BigInt(channel.ownerId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Only the group owner can remove participants",
        );

      const recipient = await db.query.channelRecipientsTable.findFirst({
        where: and(
          eq(channelRecipientsTable.channelId, BigInt(channelId)),
          eq(channelRecipientsTable.userId, BigInt(recipientId)),
        ),
      });

      if (!recipient)
        throw new HttpException(
          HttpStatusCode.NotFound,
          "User is not a participant of this group DM",
        );

      await db
        .delete(channelRecipientsTable)
        .where(
          and(
            eq(channelRecipientsTable.channelId, BigInt(channelId)),
            eq(channelRecipientsTable.userId, BigInt(recipientId)),
          ),
        );

      res.status(HttpStatusCode.Success).json({ id: channelId });

      fireAndForgetAll([
        {
          label: "event:ChannelRecipientRemove:channel",
          run: () =>
            emitEvent({
              event: "ChannelRecipientRemove",
              channel_id: channelId,
              data: { channelId, userId: recipientId },
            }),
        },
        {
          label: "event:ChannelDelete:removed",
          run: () =>
            emitEvent({
              event: "ChannelDelete",
              user_id: recipientId,
              data: { id: channelId },
            }),
        },
        {
          label: "cache:delete:channel",
          run: () => deleteCache("channel", channelId),
        },
        {
          label: "voice+call:removeRecipient",
          run: async () => {
            await VoiceStateService.kickMemberFromVoice(
              null,
              recipientId,
              "Removed from group DM",
              channelId,
            );
            await CallService.detachUserFromCall(channelId, recipientId);
          },
        },
      ]);
    } catch (err) {
      next(err);
    }
  }
}
