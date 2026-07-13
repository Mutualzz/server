import type {
    PresenceActivity,
    PresenceActivityAssets,
    PresenceActivityEmoji,
    PresencePayload,
} from "@mutualzz/types";

export const MAX_ACTIVITIES = 5;
export const MAX_STR = 128;
export const MAX_URL = 512;

export function clampStr(str: unknown, max = MAX_STR): string | undefined {
    if (typeof str !== "string") return undefined;
    const text = str.trim();
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
}

export function sanitizeActivityEmoji(
    raw: unknown,
): PresenceActivityEmoji | undefined {
    if (!raw || typeof raw !== "object") return undefined;

    const assumed = raw as PresenceActivityEmoji;
    const name = clampStr(assumed.name, 64);
    const id = clampStr(assumed.id, 32);

    if (!name && !id) return undefined;

    return {
        ...(id ? { id } : {}),
        name: name ?? "",
        ...(assumed.animated === true ? { animated: true } : {}),
    };
}

function sanitizeHttpsUrl(raw: unknown, max = MAX_URL): string | undefined {
    const text = clampStr(raw, max);
    if (!text) return undefined;
    try {
        const url = new URL(text);
        if (url.protocol !== "https:") return undefined;
        return url.toString();
    } catch {
        return undefined;
    }
}

export function sanitizeActivityAssets(
    raw: unknown,
): PresenceActivityAssets | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const assumed = raw as PresenceActivityAssets;
    const largeImageUrl = sanitizeHttpsUrl(assumed.largeImageUrl);
    const smallImageUrl = sanitizeHttpsUrl(assumed.smallImageUrl);
    const largeText = clampStr(assumed.largeText);
    const smallText = clampStr(assumed.smallText);
    if (!largeImageUrl && !smallImageUrl && !largeText && !smallText) {
        return undefined;
    }
    return {
        ...(largeImageUrl ? { largeImageUrl } : {}),
        ...(smallImageUrl ? { smallImageUrl } : {}),
        ...(largeText ? { largeText } : {}),
        ...(smallText ? { smallText } : {}),
    };
}

export function sanitizeActivity(
    activityAssumed: any,
): PresenceActivity | null {
    const allowedTypes = new Set(["playing", "listening", "custom"]);
    const type = allowedTypes.has(activityAssumed?.type)
        ? activityAssumed.type
        : "playing";

    const name = clampStr(activityAssumed?.name);
    const details = clampStr(activityAssumed?.details);
    const state = clampStr(activityAssumed?.state);
    const url = sanitizeHttpsUrl(activityAssumed?.url);
    const assets = sanitizeActivityAssets(activityAssumed?.assets);

    const timestamps =
        activityAssumed?.timestamps &&
        typeof activityAssumed.timestamps === "object"
            ? {
                  start:
                      typeof activityAssumed.timestamps.start === "number"
                          ? activityAssumed.timestamps.start
                          : undefined,
                  end:
                      typeof activityAssumed.timestamps.end === "number"
                          ? activityAssumed.timestamps.end
                          : undefined,
              }
            : undefined;

    if (type === "custom") {
        const emoji = sanitizeActivityEmoji(activityAssumed?.emoji);
        if (!state && !name && !emoji) return null;

        return {
            type,
            name: name ?? "",
            details,
            state,
            ...(emoji ? { emoji } : {}),
            timestamps,
        };
    }

    if (!name) return null;

    const applicationId = clampStr(activityAssumed?.applicationId, 32);

    return {
        type,
        name,
        ...(applicationId ? { applicationId } : {}),
        details,
        state,
        ...(url ? { url } : {}),
        ...(assets ? { assets } : {}),
        timestamps,
    };
}

export function sanitizePresence(
    presenceAssumed: any,
): Omit<PresencePayload, "updatedAt"> {
    const allowedStatus = new Set([
        "online",
        "idle",
        "dnd",
        "invisible",
        "offline",
    ]);
    const status = allowedStatus.has(presenceAssumed?.status)
        ? presenceAssumed.status
        : "online";

    const rawActs = Array.isArray(presenceAssumed?.activities)
        ? presenceAssumed.activities
        : [];

    const activities = rawActs
        .slice(0, MAX_ACTIVITIES)
        .map(sanitizeActivity)
        .filter(Boolean) as PresenceActivity[];

    const device =
        presenceAssumed?.device === "desktop" ||
        presenceAssumed?.device === "mobile" ||
        presenceAssumed?.device === "web"
            ? presenceAssumed.device
            : undefined;

    return {
        status,
        activities,
        afk:
            typeof presenceAssumed?.afk === "boolean"
                ? presenceAssumed.afk
                : undefined,
        since:
            typeof presenceAssumed?.since === "number"
                ? presenceAssumed.since
                : undefined,
        device,
    };
}
