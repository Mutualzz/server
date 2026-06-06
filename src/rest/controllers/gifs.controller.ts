import type { NextFunction, Request, Response } from "express";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { z } from "zod";
import { getCache, setCache } from "@mutualzz/cache";

const KLIPY_API_KEY = process.env.KLIPY_API_KEY!;
const BASE_URL = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}`;
const LIMIT = 30;

const MEME_TAGS = [
    "reaction",
    "happy",
    "sad",
    "angry",
    "surprised",
    "nervous",
    "crying laughing",
    "clapping",
    "facepalm",
    "eye roll",
    "thumbs up",
    "thumbs down",
    "no",
    "yes",
    "omg",
    "wtf",
    "ugh",
    "deal with it",
    "spongebob",
    "anime",
    "cat",
    "dog",
    "dancing",
    "celebrating",
    "good luck",
    "thank you",
    "sorry",
    "good morning",
    "good night",
    "love",
];

function mapGif(gif: any) {
    const file = gif.file ?? {};
    const full = file.hd ?? file.md ?? file.sm ?? {};
    const preview = file.sm ?? file.md ?? file.hd ?? {};

    return {
        id: String(gif.id),
        slug: gif.slug ?? String(gif.id),
        title: gif.title ?? "",
        url: String(full.mp4?.url ?? full.gif?.url ?? "").split("?")[0],
        preview: String(preview.gif?.url ?? preview.mp4?.url ?? "").split(
            "?",
        )[0],
        width: full.mp4?.width ?? full.gif?.width ?? 0,
        height: full.mp4?.height ?? full.gif?.height ?? 0,
    };
}

async function klipyFetch(path: string, params: Record<string, any> = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) throw new Error(`KLIPY error: ${res.status} - ${text}`);
    if (!text) return {};
    return JSON.parse(text);
}

export default class GifsController {
    static async search(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const { q, next: nextParam } = z
                .object({
                    q: z.string().trim(),
                    next: z.coerce.number().optional(),
                })
                .parse(req.query);

            const cacheKey = `${q}:${nextParam ?? 1}`;
            const cached = await getCache("gifSearch", cacheKey);
            if (cached) return res.status(HttpStatusCode.Success).json(cached);

            const data = await klipyFetch("/gifs/search", {
                q,
                per_page: LIMIT,
                page: nextParam ?? 1,
            });

            const items = data.data?.data ?? [];
            const hasNext = data.data?.has_next ?? false;
            const currentPage = data.data?.current_page ?? 1;

            const result = {
                results: items.map(mapGif),
                next: hasNext ? String(currentPage + 1) : null,
            };

            await setCache("gifSearch", cacheKey, result);
            return res.status(HttpStatusCode.Success).json(result);
        } catch (err) {
            next(err);
        }
    }

    static async tags(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            if (!user)
                throw new HttpException(
                    HttpStatusCode.Unauthorized,
                    "Unauthorized",
                );

            const cached = await getCache("gifTags", "tags");
            if (cached) return res.status(HttpStatusCode.Success).json(cached);

            const tags: { name: string; preview?: string }[] = [];
            for (const tag of MEME_TAGS) {
                const data = await klipyFetch("/gifs/search", {
                    q: tag,
                    per_page: 1,
                    page: 1,
                });

                const result = data.data.data[0];
                const previewUrl =
                    result.file.hd?.gif.url ?? result.file.md?.gif.url;
                tags.push({ name: tag, preview: previewUrl });
            }

            const result = { tags };
            await setCache("gifTags", "tags", result);
            return res.status(HttpStatusCode.Success).json(result);
        } catch (err) {
            next(err);
        }
    }
}
