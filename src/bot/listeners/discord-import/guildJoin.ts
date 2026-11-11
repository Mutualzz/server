import { markDiscordImportBotJoin } from "@mutualzz/util/DiscordImport";
import { Listener } from "@sapphire/framework";
import { type Guild, PermissionFlagsBits } from "discord.js";
import { IDS } from "../../Constants";

export default class DiscordImportGuildJoinListener extends Listener {
  constructor(context: Listener.LoaderContext, options: Listener.Options) {
    super(context, {
      ...options,
      event: "guildCreate",
      name: "discord-import-guild-join",
      description:
        "Marks servers that added the bot with Administrator so it leaves them after an import, even if the import is never finished.",
    });
  }

  async run(guild: Guild) {
    if (guild.id === IDS.MAIN_GUILD) return;

    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember?.permissions.has(PermissionFlagsBits.Administrator)) return;

    await markDiscordImportBotJoin(guild.id);
  }
}
