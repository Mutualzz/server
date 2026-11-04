import sharp from "sharp";
import { linkPreviewFetch } from "./LinkPreviewProxy";
import { isSafeFetchUrlAsync } from "./urlSafety";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5_000;
export const EXTERNAL_IMAGE_MAX_SIZE = 512;

// Fetches a user-supplied image URL (through the relay proxy in prod)
export async function fetchExternalImage(url: string): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Checked on every hop, so a redirect can't point us at an internal host
    if (!(await isSafeFetchUrlAsync(current)))
      throw new Error("Unsafe image URL");

    const res = await linkPreviewFetch(current, {
      redirect: "manual",
      signal,
      headers: { Accept: "image/*" },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect without location");
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok || !res.body) throw new Error(`Upstream ${res.status}`);

    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/") || type.includes("svg"))
      throw new Error(`Not an image (${type})`);

    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new Error("Image too large");

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("Image too large");
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks);
  }

  throw new Error("Too many redirects");
}

export async function renderExternalImage(source: Uint8Array, size: number) {
  return sharp(source)
    .resize({
      width: size,
      height: size,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer();
}
