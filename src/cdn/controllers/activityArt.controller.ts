import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { getActivityArt } from "@mutualzz/util/ActivityArt.ts";
import type { NextFunction, Request, Response } from "express";
import { MIME_TYPES } from "../Constants";

export default class ActivityArtController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const art = await getActivityArt(String(req.params.file ?? ""));
      if (!art)
        throw new HttpException(HttpStatusCode.NotFound, "Image not found");

      res.setHeader("Cache-Control", "public, max-age=7200, immutable");
      res.setHeader("Content-Type", MIME_TYPES["webp"]);
      res.status(HttpStatusCode.Success).end(art);
    } catch (err) {
      next(err);
    }
  }
}
