import { db, usersTable } from "@mutualzz/database";
import type { APIPrivateUser } from "@mutualzz/types";
import Color from "color";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import express from "express";
import sharp from "sharp";

export const base64UrlEncode = (input: Buffer | string) =>
    Buffer.from(input)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

export const createRouter = () => express.Router({ mergeParams: true });

export const genRandColor = () =>
    "#" +
    [...Array(6)]
        .map(() => (crypto.randomBytes(1)[0] % 16).toString(16))
        .join("");

export const dominantHex = async (buffer: Buffer) => {
    const { dominant } = await sharp(buffer).stats();

    return Color({
        r: dominant.r,
        g: dominant.g,
        b: dominant.b,
    }).hex();
};

export const getUser = async (id?: string): Promise<APIPrivateUser | null> => {
    if (!id) return null;

    const results = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id));

    if (!results) return null;
    if (results.length > 1)
        throw new Error(
            "Multiple users found with the same ID, this should never happen.",
        );
    if (results.length === 0) return null;
    if (!results[0]) return null;

    const { hash, ...user } = results[0];

    return user;
};
