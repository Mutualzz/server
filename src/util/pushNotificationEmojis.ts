import emojiData from "emojibase-data/en/data.json" with { type: "json" };
import shortcodesCldr from "emojibase-data/en/shortcodes/cldr.json" with { type: "json" };
import shortcodesCldrNative from "emojibase-data/en/shortcodes/cldr-native.json" with { type: "json" };
import shortcodesEmojiBase from "emojibase-data/en/shortcodes/emojibase.json" with { type: "json" };
import shortcodesGithub from "emojibase-data/en/shortcodes/github.json" with { type: "json" };
import shortcodesIamcal from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };
import shortcodesJoyPixels from "emojibase-data/en/shortcodes/joypixels.json" with { type: "json" };
import { joinShortcodes, type Emoji } from "emojibase";
import shortcodeRegexOrig from "emojibase-regex/shortcode";

const shortcodes = [
  shortcodesEmojiBase,
  shortcodesJoyPixels,
  shortcodesCldrNative,
  shortcodesGithub,
  shortcodesIamcal,
  shortcodesCldr,
];

const emojis = joinShortcodes(emojiData, shortcodes);
const shortcodeRegex = new RegExp(shortcodeRegexOrig.source, "g");
const looseShortcodeRegex = /:([a-z0-9_+\-\s]{2,}):/gi;

const normalizeShortcode = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, "_");

const compactShortcode = (name: string) => name.replace(/_/g, "");

function findEmoji(query: string): Emoji | undefined {
  const emoji = emojis.find(
    (entry) =>
      entry.shortcodes?.includes(query) ||
      entry.emoji === query ||
      entry.skins?.some(
        (skin) =>
          skin.shortcodes?.includes(query) ||
          skin.emoji === query ||
          skin.emoticon === query,
      ) ||
      entry.emoticon === query,
  );

  return (
    emoji?.skins?.find(
      (skin) =>
        skin.shortcodes?.includes(query) ||
        skin.emoji === query ||
        skin.emoticon === query,
    ) ?? emoji
  );
}

function getEmoji(shortcodeOrUnicodeOrEmoticon: string): Emoji | undefined {
  const direct = findEmoji(shortcodeOrUnicodeOrEmoticon);
  if (direct) return direct;

  const normalized = normalizeShortcode(shortcodeOrUnicodeOrEmoticon);
  if (normalized !== shortcodeOrUnicodeOrEmoticon) {
    const normalizedMatch = findEmoji(normalized);
    if (normalizedMatch) return normalizedMatch;
  }

  const compact = compactShortcode(normalized);
  if (!compact) return undefined;

  return emojis.find((entry) =>
    entry.shortcodes?.some(
      (shortcode) => compactShortcode(shortcode) === compact,
    ),
  );
}

function collectShortcodeMatches(content: string) {
  const matches: { start: number; end: number; name: string }[] = [];

  shortcodeRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = shortcodeRegex.exec(content))) {
    if (match.index > 0 && content[match.index - 1] === "<") continue;

    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      name: match[0].slice(1, -1),
    });
  }

  looseShortcodeRegex.lastIndex = 0;
  while ((match = looseShortcodeRegex.exec(content))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > 0 && content[start - 1] === "<") continue;
    if (matches.some((existing) => existing.start <= start && existing.end >= end)) {
      continue;
    }

    const name = match[1];
    if (!getEmoji(name)) continue;

    matches.push({ start, end, name });
  }

  return matches.sort((a, b) => a.start - b.start);
}

export function resolveEmojiShortcodes(content: string): string {
  const matches = collectShortcodeMatches(content);
  if (matches.length === 0) return content;

  let result = "";
  let lastIndex = 0;

  for (const shortcodeMatch of matches) {
    const emoji = getEmoji(shortcodeMatch.name);
    if (!emoji || shortcodeMatch.start < lastIndex) continue;

    result += content.slice(lastIndex, shortcodeMatch.start);
    result += emoji.emoji;
    lastIndex = shortcodeMatch.end;
  }

  return result + content.slice(lastIndex);
}
