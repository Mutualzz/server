import { GatewayCloseCodes } from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import type { Data } from "ws";
import { logger } from "../Logger";
import OPCodeHandlers from "../opcodes";
import { OPCODE_LIMITS } from "../util";
import { checkGlobalRateLimit, checkRateLimit } from "../util/RateLimit";
import type { WebSocket } from "../util/WebSocket";

export default async function Message(this: WebSocket, buffer: Data) {
    if (!checkGlobalRateLimit(this)) {
        logger.warn(`Rate limit exceeded ${this.sessionId ?? ""}`);
        return this.close(GatewayCloseCodes.RateLimit, "Rate limit exceeded");
    }

    let raw: Uint8Array;

    // ws Data can be string | Buffer | ArrayBuffer | Buffer[]
    if (typeof buffer === "string") {
        raw = new TextEncoder().encode(buffer);
    } else if (buffer instanceof Buffer) {
        raw = new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
        );
    } else if (buffer instanceof ArrayBuffer) {
        raw = new Uint8Array(buffer);
    } else if (Array.isArray(buffer)) {
        const total = buffer.reduce((n, b) => n + b.byteLength, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const b of buffer) {
            out.set(b, o);
            o += b.byteLength;
        }
        raw = out;
    } else {
        logger.error("Unknown message type");
        return;
    }

    let decoded: any;
    try {
        if (this.compressor && this.compress !== "none") {
            raw = this.compressor.decompress(raw);
        }

        if (this.codec) {
            decoded = this.codec.decode(raw);
        } else {
            // fallback JSON
            decoded = JSON.parse(new TextDecoder().decode(raw), JSONReplacer);
        }
    } catch (e: any) {
        logger.error(`Failed to decode message: ${e.stack}`);
        return;
    }

    if (!decoded || typeof decoded.op !== "number") {
        logger.error(`Invalid message format: ${JSON.stringify(decoded)}`);
        return;
    }

    if (
        !checkRateLimit(
            this,
            decoded.op,
            OPCODE_LIMITS[decoded.op]?.limit,
            OPCODE_LIMITS[decoded.op]?.window,
        )
    ) {
        logger.warn(
            `Rate limit exceeded for Opcode ${decoded.op} - ${this.sessionId}`,
        );
        return this.close(
            GatewayCloseCodes.RateLimit,
            `Rate limit exceeded for Opcode ${decoded.op}`,
        );
    }
    const OPCodeHandler =
        OPCodeHandlers[decoded.op as keyof typeof OPCodeHandlers];

    if (!OPCodeHandler) {
        logger.error(`Unknown Opcode: ${decoded.op}`);
        return;
    }

    try {
        await OPCodeHandler.call(this, decoded);
    } catch (error: any) {
        logger.error(`Error while handling Opcode ${decoded.op}`, error.stack);
    }
}
