import { HttpStatusCode } from "@mutualzz/types";
import { runDiscordImport } from "@mutualzz/util/DiscordImport";
import {
  validateDiscordImportExecute,
  validateDiscordImportPreview,
} from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import {
  discordBotInviteUrl,
  discordEmojiUrl,
  discordGuildIconUrl,
  fetchDiscordGuild,
  fetchDiscordGuildChannels,
  fetchDiscordGuildEmojis,
  fetchDiscordGuildRoles,
  mapDiscordChannelType,
  sortDiscordChannelsForDisplay,
} from "../../util/discordApi.ts";

export default class DiscordImportController {
  static async botInvite(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ url: discordBotInviteUrl() });
    } catch (error) {
      next(error);
    }
  }

  static async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const { guildId } = validateDiscordImportPreview.parse(req.body);

      const [guild, channels, roles, emojis] = await Promise.all([
        fetchDiscordGuild(guildId),
        fetchDiscordGuildChannels(guildId),
        fetchDiscordGuildRoles(guildId),
        fetchDiscordGuildEmojis(guildId),
      ]);

      const importableChannels = channels.filter(
        (channel) => mapDiscordChannelType(channel.type) !== null,
      );
      const categoryIds = new Set(
        importableChannels
          .filter((channel) => channel.type === 4)
          .map((channel) => channel.id),
      );
      const rootChannels = sortDiscordChannelsForDisplay(
        importableChannels.filter(
          (channel) =>
            !channel.parent_id || !categoryIds.has(channel.parent_id),
        ),
      );
      const orderedChannels = rootChannels.flatMap((rootChannel) => [
        rootChannel,
        ...(rootChannel.type === 4
          ? sortDiscordChannelsForDisplay(
              importableChannels.filter(
                (channel) => channel.parent_id === rootChannel.id,
              ),
            )
          : []),
      ]);

      res.json({
        guildId,
        guild: {
          name: guild.name,
          iconUrl: discordGuildIconUrl(guild),
        },
        channels: orderedChannels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: mapDiscordChannelType(channel.type),
          parentId:
            channel.parent_id && categoryIds.has(channel.parent_id)
              ? channel.parent_id
              : null,
        })),
        roles: roles
          .filter((role) => role.id !== guildId)
          .filter((role) => !role.managed)
          .sort((first, second) => second.position - first.position)
          .map((role) => ({
            id: role.id,
            name: role.name,
            color: role.color
              ? `#${role.color.toString(16).padStart(6, "0")}`
              : null,
            hoist: role.hoist,
          })),
        emojis: emojis.slice(0, 100).map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          url: discordEmojiUrl(emoji),
        })),
        skippedChannelCount: channels.length - importableChannels.length,
        skippedEmojiCount: Math.max(0, emojis.length - 100),
      });
    } catch (error) {
      next(error);
    }
  }

  static async execute(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { guildId, spaceName } = validateDiscordImportExecute.parse(
        req.body,
      );

      const result = await runDiscordImport({
        userId: user.id,
        guildId,
        spaceName,
      });

      res.status(HttpStatusCode.Created).json(result);
    } catch (error) {
      next(error);
    }
  }
}
