import crypto from "crypto";
import { redis } from "./Redis";

const APPEAL_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export type ResolvedAppealToken =
    | { type: "account"; userId: string }
    | { type: "space_lockdown"; userId: string; spaceId: string };

export const generateAppealToken = async (userId: string) => {
    const token = crypto.randomBytes(32).toString("hex");
    await redis.set(
        `accountAppeal:${token}`,
        userId,
        "EX",
        APPEAL_TOKEN_TTL_SECONDS,
    );
    return token;
};

export const generateSpaceAppealToken = async (
    spaceId: string,
    ownerId: string,
) => {
    const token = crypto.randomBytes(32).toString("hex");
    await redis.set(
        `spaceAppeal:${token}`,
        JSON.stringify({ spaceId, ownerId }),
        "EX",
        APPEAL_TOKEN_TTL_SECONDS,
    );
    return token;
};

export const resolveAppealToken = async (
    token: string,
): Promise<ResolvedAppealToken | null> => {
    const accountUserId = await redis.get(`accountAppeal:${token}`);
    if (accountUserId) {
        return { type: "account", userId: accountUserId };
    }

    const spacePayload = await redis.get(`spaceAppeal:${token}`);
    if (!spacePayload) return null;

    try {
        const parsed = JSON.parse(spacePayload) as {
            spaceId?: string;
            ownerId?: string;
        };

        if (!parsed.spaceId || !parsed.ownerId) return null;

        return {
            type: "space_lockdown",
            userId: parsed.ownerId,
            spaceId: parsed.spaceId,
        };
    } catch {
        return null;
    }
};

export const consumeAppealToken = async (token: string) => {
    await redis.del(`accountAppeal:${token}`, `spaceAppeal:${token}`);
};

export const buildAppealUrl = (token: string) => {
    const domain =
        process.env.NODE_ENV === "development"
            ? process.env.FRONTEND_URL
            : "https://mutualzz.com";
    return `${domain}/appeal?token=${token}`;
};
