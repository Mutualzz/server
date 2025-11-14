import crypto from "crypto";

export const ALLOWED_FORMATS = new Set([
    "png",
    "webp",
    "avif",
    "jpg",
    "jpeg",
    "gif",
]);

export function normalizeFormat(fmt?: string | null) {
    if (!fmt) return undefined;
    const f = fmt.toLowerCase();
    if (!ALLOWED_FORMATS.has(f)) return undefined;
    return f === "jpeg" ? "jpg" : f;
}

export const contentEtag = (buf: Uint8Array) =>
    'W/"' + crypto.createHash("sha1").update(buf).digest("hex") + '"';
