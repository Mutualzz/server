import { Snowflake } from "@theinternetfolks/snowflake";
import os from "os";

export const SNOWFLAKE_EPOCH = 1735737360000;

// Derive a stable shard id (0–1023)
const machineHash =
    Math.abs(
        os
            .hostname()
            .split("")
            .reduce((a, c) => a + c.charCodeAt(0), 0),
    ) % 32;
const procHash =
    (process.env.PM2_INSTANCE_ID
        ? Number(process.env.PM2_INSTANCE_ID)
        : process.pid) % 32;
const shardId = (machineHash << 5) | procHash;

export const genSnowflake = () =>
    Snowflake.generate({
        timestamp: SNOWFLAKE_EPOCH,
        shard_id: shardId,
    });
