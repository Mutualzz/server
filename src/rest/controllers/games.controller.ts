import type { NextFunction, Request, Response } from "express";
import { getCache, setCache } from "@mutualzz/cache";
import { HttpStatusCode } from "@mutualzz/types";
import {
  getGameCatalogEtag,
  getGameCatalogPublic,
  loadGameCatalog,
} from "@mutualzz/util/GameCatalog.ts";
import { isIgdbConfigured, searchGameIcon } from "@mutualzz/util/Igdb.ts";
import { z } from "zod";

export default class GamesController {
  static async catalog(req: Request, res: Response, next: NextFunction) {
    try {
      const catalog = await loadGameCatalog();
      const tag = getGameCatalogEtag();
      if (tag && req.headers["if-none-match"] === tag) {
        res.status(304).end();
        return;
      }

      if (tag) res.setHeader("ETag", tag);
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res
        .status(HttpStatusCode.Success)
        .json(getGameCatalogPublic(catalog));
    } catch (err) {
      next(err);
    }
  }

  static async icon(req: Request, res: Response, next: NextFunction) {
    try {
      if (!isIgdbConfigured()) {
        return res.sendStatus(503);
      }

      const { q } = z
        .object({
          q: z.string().trim().min(1).max(100),
        })
        .parse(req.query);

      const cacheKey = q.toLowerCase();
      const cached = await getCache("gameIcon", cacheKey);
      if (cached) {
        return res.status(HttpStatusCode.Success).json(cached);
      }

      const result = await searchGameIcon(q);
      if (!result) {
        return res.sendStatus(HttpStatusCode.NotFound);
      }

      await setCache("gameIcon", cacheKey, result);
      return res.status(HttpStatusCode.Success).json(result);
    } catch (err) {
      next(err);
    }
  }
}
