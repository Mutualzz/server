import { deflate, inflate } from "pako";
import type { Compression } from "./Negotation";

export interface Compressor {
    name: Compression;
    compress(bytes: Uint8Array): Uint8Array;
    decompress(bytes: Uint8Array): Uint8Array;
}

export async function createCompressor(name: Compression): Promise<Compressor> {
    if (name === "zlib-stream") {
        return {
            name: "zlib-stream",
            compress: (bytes) => deflate(bytes, { level: 6 }),
            decompress: (bytes) => inflate(bytes),
        };
    }

    return {
        name: "none",
        compress: (b) => b,
        decompress: (b) => b,
    };
}
