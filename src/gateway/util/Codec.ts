import type { WireGatewayPayload } from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import { logger } from "../Logger";
import type { Encoding } from "./Negotation";

export interface Codec {
    name: Encoding;
    encode(data: WireGatewayPayload): Uint8Array;
    decode(bytes: Uint8Array): any;
}

export async function createCodec(encoding: Encoding): Promise<Codec> {
    if (encoding === "etf") {
        try {
            const erl = await import("erlpack");
            return {
                name: "etf",
                encode: (data) => erl.pack(data),
                decode: (bytes) =>
                    erl.unpack(bytes as ReturnType<typeof erl.pack>),
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
            new TextEncoder().encode(JSON.stringify(data, JSONReplacer)),
        decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    };
}
