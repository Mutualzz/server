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
    console.log(encoding);
    if (encoding === "etf") {
        try {
            const erl = await import("@yukikaze-bot/erlpack");

            return {
                name: "etf",
                encode: (data) => erl.pack(data),
                decode: (bytes) => {
                    return erl.unpack(bytes);
                },
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
