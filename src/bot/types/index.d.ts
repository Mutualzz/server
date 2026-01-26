import { type AbstractMessageMenuCommand } from "../classes/MessageMenuCommand";
import type { AbstractSlashCommand } from "../classes/SlashCommand";
import type { AbstractSlashSubcommand } from "../classes/SlashSubcommand";
import { type AbstractUserMenuCommand } from "../classes/UserMenuCommand";
import type {
    SlashCommandAttachmentOption,
    SlashCommandBooleanOption,
    SlashCommandChannelOption,
    SlashCommandIntegerOption,
    SlashCommandMentionableOption,
    SlashCommandNumberOption,
    SlashCommandRoleOption,
    SlashCommandStringOption,
    SlashCommandUserOption,
} from "discord.js";

export type AllCommands =
    | AbstractSlashCommand
    | AbstractSlashSubcommand
    | AbstractMessageMenuCommand
    | AbstractUserMenuCommand;

export type SlashCommandOption =
    | SlashCommandAttachmentOption
    | SlashCommandChannelOption
    | SlashCommandBooleanOption
    | SlashCommandIntegerOption
    | SlashCommandMentionableOption
    | SlashCommandNumberOption
    | SlashCommandRoleOption
    | SlashCommandStringOption
    | SlashCommandUserOption;
