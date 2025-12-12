import crypto from "crypto";

export const generateHash = (buffer: Buffer, animated = false) => {
    return `${animated ? "a_" : ""}${crypto.createHash("sha256").update(buffer).digest("hex")}`;
};
