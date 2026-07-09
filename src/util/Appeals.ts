import crypto from "crypto";
import { redis } from "./Redis";

const APPEAL_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

export const buildAppealUrl = (token: string) => {
    const domain =
        process.env.NODE_ENV === "development"
            ? process.env.FRONTEND_URL
            : "https://mutualzz.com";
    return `${domain}/appeal?token=${token}`;
};
