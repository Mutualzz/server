import { resolveEmojiShortcodes } from "./pushNotificationEmojis.js";

const SPOILER_REPLACEMENT = "******";

const customEmojiRegex = /<a?:([^:>]+):\d+>/g;
const mentionUserRegex = /<@!?(\d+)>/g;
const mentionRoleRegex = /<@&(\d+)>/g;
const spoilerRegex = /\|\|([^|]+?)\|\|/g;
const codeBlockRegex = /```[\s\S]*?```/g;
const inlineCodeRegex = /`([^`]+)`/g;
const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
const boldRegex = /\*\*([^*]+?)\*\*/g;
const underlineRegex = /__([^_]+?)__/g;
const italicAsteriskRegex = /(?<!\*)\*([^*]+?)\*(?!\*)/g;
const italicUnderscoreRegex = /(?<!_)_([^_]+?)_(?!_)/g;
const strikethroughRegex = /~~([^~]+?)~~/g;
const unicodeEmojiBetweenColonsRegex =
  /:([\p{Extended_Pictographic}\u200d\ufe0f]+):/gu;

function stripFormattingMarkers(text: string): string {
  const stripped = text
    .replace(codeBlockRegex, (match) =>
      match.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""),
    )
    .replace(inlineCodeRegex, "$1")
    .replace(spoilerRegex, SPOILER_REPLACEMENT)
    .replace(customEmojiRegex, ":$1:")
    .replace(mentionUserRegex, "@user")
    .replace(mentionRoleRegex, "@role")
    .replace(markdownLinkRegex, "$1")
    .replace(boldRegex, "$1")
    .replace(underlineRegex, "$1")
    .replace(strikethroughRegex, "$1")
    .replace(italicAsteriskRegex, "$1")
    .replace(italicUnderscoreRegex, "$1")
    .replace(unicodeEmojiBetweenColonsRegex, "$1")
    .replace(/@everyone/g, "@everyone")
    .replace(/@here/g, "@here");

  return resolveEmojiShortcodes(stripped)
    .replace(/\s+/g, " ")
    .trim();
}

export function formatPushNotificationBody(
  content: string | null | undefined,
  authorName: string,
  maxLength = 120,
): string {
  if (!content?.trim()) {
    return `${authorName} sent a message`;
  }

  const stripped = stripFormattingMarkers(content);
  if (!stripped) {
    return `${authorName} sent a message`;
  }

  if (stripped.length <= maxLength) {
    return stripped;
  }

  return `${stripped.slice(0, maxLength - 3)}...`;
}
