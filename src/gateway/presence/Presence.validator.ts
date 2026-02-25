import type { PresenceActivity, PresencePayload } from "@mutualzz/types";

export const MAX_ACTIVITIES = 5;
export const MAX_STR = 128;

export function clampStr(str: unknown, max = MAX_STR): string | undefined {
    if (typeof str !== "string") return undefined;
    const text = str.trim();
    if (!text) return undefined;
    return text.length > max ? text.slice(0, max) : text;
}

export function sanitizeActivity(
    activityAssumed: any,
): PresenceActivity | null {
    const name = clampStr(activityAssumed?.name);
    if (!name) return null;

    const allowedTypes = new Set(["playing", "listening", "custom"]);
    const type = allowedTypes.has(activityAssumed?.type)
        ? activityAssumed.type
        : "playing";

    const details = clampStr(activityAssumed?.details);
    const state = clampStr(activityAssumed?.state);

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

    return { type, name, details, state, timestamps };
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
