import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, } from "@aws-sdk/client-s3";
import { deleteCache, invalidateCache, setCache } from "@mutualzz/cache";
import {
  channelsTable,
  db,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  spacesTable,
  toPublicUser,
  userSettingsTable,
} from "@mutualzz/database";
import {
  bucketName,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  generateHash,
  getMember,
  getSpace,
  requireSpacePermissions,
  s3Client,
  Snowflake,
} from "@mutualzz/util";
import type { APIChannel, APIRole, APISpace, APISpaceMember, APIUserSettings, } from "@mutualzz/types";
import { ChannelType, HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  imageFileValidator,
  validateSpaceCreate,
  validateSpaceDeleteParams,
  validateSpaceGetBulkQuery,
  validateSpaceGetOneParams,
  validateSpaceUpdate,
  validateSpaceUpdateParams,
} from "@mutualzz/validators";
import { eq, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { memberFlags, permissionFlags, roleFlags } from "@mutualzz/bitfield";

export default class SpacesController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      let rawCrop;
      if (req.body.crop) rawCrop = JSON.parse(req.body.crop);
      const { crop, name } = validateSpaceCreate.parse({
        ...req.body,
        crop: rawCrop,
      });

      const iconFile = imageFileValidator.optional().parse(req.file);

      const spaceId = BigInt(Snowflake.generate());

      const spaceValues: typeof spacesTable.$inferInsert = {
        id: spaceId,
        name,
        ownerId: BigInt(user.id),
      };

      if (iconFile) {
        const isGif = iconFile.mimetype === "image/gif";

        let iconSharp: sharp.Sharp;
        if (isGif) iconSharp = sharp(iconFile.buffer, { animated: true });
        else iconSharp = sharp(iconFile.buffer).toFormat("png");

        if (crop) {
          const { x, y, width, height } = crop;
          iconSharp = iconSharp.extract({
            left: x,
            top: y,
            width,
            height,
          });
        }

        const iconBuffer = await iconSharp.toBuffer();

        const iconHash = generateHash(
          iconBuffer,
          iconFile.mimetype.includes("gif"),
        );

        let existingIcon = null;
        const storedExt = isGif ? "gif" : "png";

        try {
          const { Body } = await s3Client.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: `icons/spaces/${spaceId}/${iconHash}.${storedExt}`,
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
              Body: iconBuffer,
              Key: `icons/spaces/${spaceId}/${iconHash}.${storedExt}`,
              ContentType: isGif ? "image/gif" : "image/png",
            }),
          );
        }

        spaceValues.icon = iconHash;
      }

      const { space, settings } = await db.transaction(async (tx) => {
        const newSpace = await execNormalized<APISpace | null>(
          tx
            .insert(spacesTable)
            .values(spaceValues)
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!newSpace)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create space",
          );

        // Note: Keep adding bits when you need
        const everyoneRole = await execNormalized<APIRole | null>(
          tx

            .insert(rolesTable)
            .values({
              id: BigInt(newSpace.id),
              name: "@everyone",
              spaceId: BigInt(newSpace.id),
              flags: roleFlags.Everyone,
              allow:
                permissionFlags.ViewChannel |
                permissionFlags.SendMessages |
                permissionFlags.CreateInvites |
                permissionFlags.Connect |
                permissionFlags.Speak |
                permissionFlags.AttachFiles |
                permissionFlags.ReadMessageHistory |
                permissionFlags.UseExternalEmojis |
                permissionFlags.EmbedLinks,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!everyoneRole)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create default role",
          );

        const newMember = await execNormalized<APISpaceMember | null>(
          tx
            .insert(spaceMembersTable)
            .values({
              spaceId: BigInt(newSpace.id),
              userId: BigInt(user.id),
              flags: memberFlags.Owner,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        await tx.insert(spaceMemberRolesTable).values({
          spaceId: BigInt(newSpace.id),
          userId: BigInt(user.id),
          roleId: BigInt(everyoneRole.id),
        });

        if (!newMember)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create space member",
          );

        const textCategory = await execNormalized<APIChannel | null>(
          tx
            .insert(channelsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              type: ChannelType.Category,
              spaceId: BigInt(newSpace.id),
              name: "Text Channels",
              position: 0,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!textCategory)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create default category",
          );

        const defaultTextChannel = await execNormalized<APIChannel | null>(
          tx
            .insert(channelsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              type: ChannelType.Text,
              spaceId: BigInt(newSpace.id),
              name: "General",
              position: 0,
              parentId: BigInt(textCategory.id),
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!defaultTextChannel)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create default channel",
          );

        const voiceCategory = await execNormalized<APIChannel | null>(
          tx
            .insert(channelsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              type: ChannelType.Category,
              spaceId: BigInt(newSpace.id),
              name: "Voice Channels",
              position: 1,
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!voiceCategory)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create voice category",
          );

        const defaultVoiceChannel = await execNormalized<APIChannel | null>(
          tx
            .insert(channelsTable)
            .values({
              id: BigInt(Snowflake.generate()),
              type: ChannelType.Voice,
              spaceId: BigInt(newSpace.id),
              name: "General",
              position: 0,
              parentId: BigInt(voiceCategory.id),
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!defaultVoiceChannel)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create default voice channel",
          );

        const settings = await execNormalized<APIUserSettings | null>(
          tx
            .insert(userSettingsTable)
            .values({
              userId: BigInt(user.id),
              spacePositions: [BigInt(newSpace.id)],
            })
            .onConflictDoUpdate({
              target: userSettingsTable.userId,
              set: {
                spacePositions: sql`array_prepend(${newSpace.id}, COALESCE(${userSettingsTable.spacePositions}, ARRAY[]::bigint[]))`,
              },
            })
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!settings)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to create user settings",
          );

        const channels = [
          textCategory,
          defaultTextChannel,
          voiceCategory,
          defaultVoiceChannel,
        ].map((ch) => ({
          ...ch,
          space: newSpace,
        }));
        const roles = [everyoneRole];
        const members = [
          {
            ...newMember,
            user: toPublicUser(user),
          },
        ];

        void setCache("channel", textCategory.id, textCategory);
        void setCache("channel", defaultTextChannel.id, defaultTextChannel);
        void setCache("channel", voiceCategory.id, voiceCategory);
        void setCache("channel", defaultVoiceChannel.id, defaultVoiceChannel);
        void setCache("spaceMember", `${newSpace.id}:${user.id}`, newMember);
        void setCache("space", newSpace.id, newSpace);
        void setCache("userSettings", user.id, settings);

        return {
          space: {
            ...newSpace,
            channels,
            roles,
            members,
            owner: toPublicUser(user),
          },
          settings,
        };
      });

      const { channels, members, owner, ...plainSpace } = space;

      res.status(HttpStatusCode.Created).json(plainSpace);

      fireAndForgetAll([
        {
          label: "event:SpaceCreate",
          run: () =>
            emitEvent({
              event: "SpaceCreate",
              user_id: user.id,
              data: space,
            }),
          meta: {
            spaceId,
            userId: user.id,
          },
        },
        {
          label: "event:UserSettingsUpdate",
          run: () =>
            emitEvent({
              event: "UserSettingsUpdate",
              user_id: user.id,
              data: settings,
            }),
          meta: {
            userId: user.id,
          },
        },
      ]);
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateSpaceUpdateParams.parse(req.params);

      const { space } = await requireSpacePermissions({
        spaceId,
        userId: user.id,
        needed: ["ManageSpace"],
      });

      let rawCrop;
      if (req.body.crop) rawCrop = JSON.parse(req.body.crop);
      const { name, description, crop } = validateSpaceUpdate.parse({
        ...req.body,
        crop: rawCrop,
      });

      const iconFile = imageFileValidator.optional().parse(req.file);
      const removeIcon = req.body.icon === "";

      const updates: Partial<typeof spacesTable.$inferInsert> = {};

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;

      if (removeIcon) {
        if (space.icon) {
          const isGif = space.icon.startsWith("a_");
          const storedExt = isGif ? "gif" : "png";
          try {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: bucketName,
                Key: `icons/spaces/${space.id}/${space.icon}.${storedExt}`,
              }),
            );
          } catch {
            // ignore
          }
        }
        updates.icon = null;
      } else if (iconFile) {
        const isGif = iconFile.mimetype === "image/gif";

        let iconSharp: sharp.Sharp;
        if (isGif) iconSharp = sharp(iconFile.buffer, { animated: true });
        else iconSharp = sharp(iconFile.buffer).toFormat("png");

        if (crop) {
          const { x, y, width, height } = crop;
          iconSharp = iconSharp.extract({ left: x, top: y, width, height });
        }

        const iconBuffer = await iconSharp.toBuffer();
        const iconHash = generateHash(iconBuffer, isGif);
        const storedExt = isGif ? "gif" : "png";

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Body: iconBuffer,
            Key: `icons/spaces/${space.id}/${iconHash}.${storedExt}`,
            ContentType: isGif ? "image/gif" : "image/png",
          }),
        );

        if (space.icon && space.icon !== iconHash) {
          const oldExt = space.icon.startsWith("a_") ? "gif" : "png";
          try {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: bucketName,
                Key: `icons/spaces/${space.id}/${space.icon}.${oldExt}`,
              }),
            );
          } catch {
            // ignore
          }
        }

        updates.icon = iconHash;
      }

      if (Object.keys(updates).length === 0) {
        res.status(HttpStatusCode.Success).json(space);
        return;
      }

      const updatedSpace = await execNormalized<APISpace>(
        db
          .update(spacesTable)
          .set(updates)
          .where(eq(spacesTable.id, BigInt(space.id)))
          .returning()
          .then((res) => (res.length ? res[0] : null)),
      );

      if (!updatedSpace)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update space",
        );

      void setCache("space", updatedSpace.id, updatedSpace);
      void invalidateCache("spaceHydrated", updatedSpace.id);

      res.status(HttpStatusCode.Success).json(updatedSpace);

      void emitEvent({
        event: "SpaceUpdate",
        space_id: updatedSpace.id,
        data: updatedSpace,
      });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateSpaceDeleteParams.parse(req.params);

      const space = await getSpace(spaceId);

      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      if (BigInt(space.ownerId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You do not have permission to delete this space",
        );

      if (space.icon) {
        const isGif = space.icon.startsWith("a_");
        const storedExt = isGif ? "gif" : "png";

        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: `icons/spaces/${space.id}/${space.icon}.${storedExt}`,
            }),
          );
        } catch {
          // Ignore
        }
      }

      const { settings, deletedSpace } = await db.transaction(async (tx) => {
        const updatedSettings = await execNormalized<APIUserSettings | null>(
          tx
            .update(userSettingsTable)
            .set({
              spacePositions: sql`array_remove(${userSettingsTable.spacePositions}, ${space.id})`,
            })
            .where(eq(userSettingsTable.userId, BigInt(user.id)))
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!updatedSettings)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to update user settings",
          );

        const deletedSpace = await execNormalized<APISpace | null>(
          tx
            .delete(spacesTable)
            .where(eq(spacesTable.id, BigInt(space.id)))
            .returning()
            .then((res) => (res.length ? res[0] : null)),
        );

        if (!deletedSpace)
          throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to delete space",
          );

        void deleteCache("space", space.id);
        void deleteCache("spaceMember", `${space.id}:${user.id}`);
        void deleteCache("spaceMembers", space.id);
        void setCache("userSettings", user.id, updatedSettings);
        void invalidateCache("spaceHydrated", space.id);

        return {
          settings: updatedSettings,
          deletedSpace: deletedSpace,
        };
      });

      res.status(HttpStatusCode.Success).json({ id: deletedSpace.id });

      fireAndForgetAll([
        {
          label: "event:SpaceDelete",
          run: () =>
            emitEvent({
              event: "SpaceDelete",
              space_id: deletedSpace.id,
              data: { id: deletedSpace.id },
            }),
          meta: {
            spaceId: deletedSpace.id,
          },
        },
        {
          label: "event:UserSettingsUpdate",
          run: () =>
            emitEvent({
              event: "UserSettingsUpdate",
              user_id: user.id,
              data: settings,
            }),
          meta: {
            userId: user.id,
          },
        },
      ]);
    } catch (error) {
      next(error);
    }
  }

  static async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const spaces = await execNormalizedMany<APISpace>(
        db.query.spacesTable.findMany({
          where: sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.spaceId} = ${spacesTable.id} AND ${spaceMembersTable.userId} = ${user.id})`,
        }),
      );

      res.status(HttpStatusCode.Success).json(spaces);
    } catch (error) {
      next(error);
    }
  }

  static async getOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { spaceId } = validateSpaceGetOneParams.parse(req.params);

      const space = await getSpace(spaceId);

      if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

      const me = await getMember(spaceId, user.id, true);
      if (!me)
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You do not have permission to view this space",
        );

      res.status(HttpStatusCode.Success).json(space);
    } catch (error) {
      next(error);
    }
  }

  static async getBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { limit } = validateSpaceGetBulkQuery.parse(req.query);

      const spaces = await execNormalizedMany<APISpace>(
        db.query.spacesTable.findMany({
          limit: limit || 50,
          where: sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.spaceId} = ${spacesTable.id} AND ${spaceMembersTable.userId} = ${user.id})`,
        }),
      );

      res.status(HttpStatusCode.Success).json(spaces);
    } catch (error) {
      next(error);
    }
  }
}
