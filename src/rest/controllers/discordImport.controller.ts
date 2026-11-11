import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  hasDiscordImportGrant,
  MAX_IMPORTED_EXPRESSIONS,
} from "@mutualzz/util/DiscordImport";
import { validateDiscordImportPreview } from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import {
  discordEmojiUrl,
  discordGuildIconUrl,
  discordStickerUrl,
  fetchDiscordGuild,
  fetchDiscordGuildChannels,
  fetchDiscordGuildEmojis,
  fetchDiscordGuildRoles,
  fetchDiscordGuildStickers,
  isDiscordChannelPrivate,
  isImportableDiscordSticker,
  mapDiscordChannelType,
  sortDiscordChannelsForDisplay,
} from "../../util/discordApi.ts";

export default class DiscordImportController {
  static async preview(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;
      const { guildId } = validateDiscordImportPreview.parse(req.body);

      if (!(await hasDiscordImportGrant(user.id, guildId))) {
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "Authorize the Mutualzz bot for this server before previewing it",
        );
      }

      const [guild, channels, roles, emojis, stickers] = await Promise.all([
        fetchDiscordGuild(guildId),
        fetchDiscordGuildChannels(guildId),
        fetchDiscordGuildRoles(guildId),
        fetchDiscordGuildEmojis(guildId),
        fetchDiscordGuildStickers(guildId),
      ]);
      const importableStickers = stickers.filter(isImportableDiscordSticker);

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
          description: guild.description ?? null,
        },
        channels: orderedChannels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: mapDiscordChannelType(channel.type),
          topic: channel.topic ?? null,
          nsfw: channel.nsfw ?? false,
          isPrivate: isDiscordChannelPrivate(channel, guildId),
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
        emojis: emojis.map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          url: discordEmojiUrl(emoji),
        })),
        stickers: importableStickers.map((sticker) => ({
          id: sticker.id,
          name: sticker.name,
          url: discordStickerUrl(sticker),
        })),
        maxExpressions: MAX_IMPORTED_EXPRESSIONS,
        skippedChannelCount: channels.length - importableChannels.length,
        skippedStickerCount: stickers.length - importableStickers.length,
      });
    } catch (error) {
      next(error);
    }
  }
}
