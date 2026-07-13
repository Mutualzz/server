import crypto from "node:crypto";

export const INSTANCE_ID = process.env.INSTANCE_ID ?? crypto.randomUUID();
