import { externalImageCache, getCache } from "@mutualzz/cache";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { verifyExternalImage } from "@mutualzz/util/activityImageProxy.ts";
import {
  EXTERNAL_IMAGE_MAX_SIZE,
  fetchExternalImage,
  renderExternalImage,
} from "@mutualzz/util/externalImage.ts";
import {
  externalImageGetParams,
  externalImageGetQuery,
} from "@mutualzz/validators";
import type { NextFunction, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import { MIME_TYPES } from "../Constants";
import { contentEtag } from "../utils";

// Remember upstream failures briefly so a broken image in a popular presence
// doesn't make us refetch it for every viewer
const failures = new LRUCache<string, true>({ max: 1000, ttl: 5 * 60 * 1000 });

export default class ExternalController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { signature, encoded } = externalImageGetParams.parse(req.params);
      const { size } = externalImageGetQuery.parse(req.query);

      const url = verifyExternalImage(signature, encoded);
      if (!url)
        throw new HttpException(HttpStatusCode.NotFound, "Image not found");

      const targetSize = Math.min(
        size ?? EXTERNAL_IMAGE_MAX_SIZE,
        EXTERNAL_IMAGE_MAX_SIZE,
      );
      const cacheKey = `${signature}:${targetSize}`;

      let output = await getCache("externalImage", cacheKey);

      if (!output) {
        if (failures.has(signature))
          throw new HttpException(HttpStatusCode.NotFound, "Image not found");

        try {
          output = await renderExternalImage(
            await fetchExternalImage(url),
            targetSize,
          );
        } catch {
          failures.set(signature, true);
          throw new HttpException(HttpStatusCode.NotFound, "Image not found");
        }

        externalImageCache.set(cacheKey, output);
      }

      // Not immutable: the upstream image behind the URL may change
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("ETag", contentEtag(output));
      res.setHeader("Content-Type", MIME_TYPES["webp"]);
      res.status(HttpStatusCode.Success).end(Buffer.from(output));
    } catch (err) {
      next(err);
    }
  }
}
