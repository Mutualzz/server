import { deflate, inflate } from "pako";
import type { Compression } from "./Negotation";

export interface Compressor {
    name: Compression;
    compress(bytes: Uint8Array): Uint8Array;
    decompress(bytes: Uint8Array): Uint8Array;
}

function toUint8Array(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
}

export async function createCompressor(name: Compression): Promise<Compressor> {
    if (name === "zlib-stream") {
        return {
            name: "zlib-stream",
            compress: (bytes) => toUint8Array(deflate(bytes, { level: 6 })),
            decompress: (bytes) => toUint8Array(inflate(bytes)),
        };
    }

    return {
        name: "none",
        compress: (b) => toUint8Array(b),
        decompress: (b) => toUint8Array(b),
    };
}
