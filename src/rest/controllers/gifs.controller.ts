/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { IGif } from "@giphy/js-types";
import type { NextFunction, Request, Response } from "express";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { z } from "zod";
import { getCache, setCache } from "@mutualzz/cache";

const gf = new GiphyFetch(process.env.GIPHY_API_KEY!);
const LIMIT = 30;
const RATING = "pg-13" as const;

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

function mapGif(gif: IGif) {
    const url = String(
        gif.images.original_mp4?.mp4 ?? gif.images.original.url ?? "",
    ).split("?")[0];
    const preview = String(
        gif.images.fixed_height_small.mp4 ??
            gif.images.fixed_height_small.url ??
            "",
    ).split("?")[0];

    return {
        id: gif.id.toString(),
        title: gif.title,
        url,
        preview,
        width: gif.images.original.width,
        height: gif.images.original.height,
    };
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
                    next: z.number().optional(),
                })
                .parse(req.query);

            const cacheKey = `${q}:${nextParam ?? 0}`;
            const cached = await getCache("gifSearch", cacheKey);
            if (cached) return res.status(HttpStatusCode.Success).json(cached);

            const { data, pagination } = await gf.search(q, {
                limit: LIMIT,
                rating: RATING,
                offset: nextParam || 0,
            });

            const offset = pagination.offset ?? 0;
            const hasMore = offset + LIMIT < (pagination.total_count ?? 0);
            const result = {
                results: data.map(mapGif),
                next: hasMore ? String(offset + LIMIT) : null,
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

            const tags = (
                await Promise.all(
                    MEME_TAGS.map(async (term) => {
                        try {
                            const { data } = await gf.search(term, {
                                limit: 1,
                                rating: RATING,
                            });
                            const gif = data[0];
                            if (!gif) return null;
                            return {
                                name: term,
                                preview: String(
                                    gif.images.fixed_height_small.mp4 ??
                                        gif.images.fixed_height_small.url ??
                                        "",
                                ).split("?")[0],
                            };
                        } catch {
                            return null;
                        }
                    }),
                )
            ).filter(Boolean);

            const result = { tags };
            await   setCache("gifTags", "tags", result);

            return res.status(HttpStatusCode.Success).json(result);
        } catch (err) {
            next(err);
        }
    }
}
