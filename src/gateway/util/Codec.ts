import type { WireGatewayPayload } from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import { logger } from "../Logger";
import type { Encoding } from "./Negotation";

export interface Codec {
    name: Encoding;
    encode(data: WireGatewayPayload): ArrayBuffer;
    decode(bytes: Uint8Array): any;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

export async function createCodec(encoding: Encoding): Promise<Codec> {
    if (encoding === "etf") {
        try {
            const erl = await import("harmony-erlpack");

            return {
                name: "etf",
                encode: (data) => erl.pack(data) as ArrayBuffer,
                decode: (bytes) => erl.unpack(toArrayBuffer(bytes)),
            };
        } catch (err: any) {
            logger.error(
                `Failed to load erlpack, falling back to JSON codec ${err.stack}`,
            );
        }
    }

    return {
        name: "json",
        encode: (data) =>
            new TextEncoder().encode(JSON.stringify(data, JSONReplacer)).buffer,
        decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    };
}
