export type Encoding = "json" | "etf";
export type Compression = "none" | "zlib-stream";

const ALLOWED_ENCODINGS = new Set<Encoding>(["json", "etf"]);
const ALLOWED_COMPRESSIONS = new Set<Compression>(["none", "zlib-stream"]);

export function parseNegotiationParams(url: string): {
    encoding: Encoding;
    compress: Compression;
} {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        u = new URL(
            url,
            process.env.NODE_ENV === "development"
                ? "ws://localhost:4000"
                : "wss://gateway.mutualzz.com",
        );
    }
    const enc = (u.searchParams.get("encoding") ?? "json") as Encoding;
    const cmp = (u.searchParams.get("compress") ??
        "zlib-stream") as Compression;

    return {
        encoding: ALLOWED_ENCODINGS.has(enc) ? enc : "json",
        // default to zlib-stream if not chosen
        compress: ALLOWED_COMPRESSIONS.has(cmp) ? cmp : "zlib-stream",
    };
}
