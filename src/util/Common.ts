import { Snowflake } from "@theinternetfolks/snowflake";
import Color from "color";
import crypto from "crypto";
import express from "express";
import sharp from "sharp";
import { threadId } from "worker_threads";
import { SNOWFLAKE_EPOCH_TIMESTAMP } from "./Constants";

export const genSnowflake = () =>
    Snowflake.generate({
        timestamp: SNOWFLAKE_EPOCH_TIMESTAMP,
        shard_id: threadId,
    });

export const base64UrlEncode = (input: Buffer | string) =>
    Buffer.from(input)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

export const createRouter = () => express.Router({ mergeParams: true });

export const genRandColor = () =>
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
