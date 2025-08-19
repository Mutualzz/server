import { Snowflake } from "@theinternetfolks/snowflake";
import express from "express";
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
