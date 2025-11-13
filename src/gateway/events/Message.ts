import { JSONReplacer } from "@mutualzz/util";
import type { Data } from "ws";
import { logger } from "../Logger";
import OPCodeHandlers from "../opcodes";
import type { WebSocket } from "../util/WebSocket";

export async function Message(this: WebSocket, buffer: Data) {
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
        logger.error("[Gateway] Unknown message type");
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
        logger.error(`[Gateway] Failed to decode message: ${e.stack}`);
        return;
    }

    const OPCodeHandler =
        OPCodeHandlers[decoded.op as keyof typeof OPCodeHandlers];

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!OPCodeHandler) {
        logger.error(`[Gateway] Unknown Opcode: ${decoded.op}`);
        return;
    }

    try {
        await OPCodeHandler.call(this, decoded);
    } catch (error: any) {
        logger.error(
            `[Gateway] Error while handling Opcode ${decoded.op}: ${error.stack}`,
        );
    }
}
