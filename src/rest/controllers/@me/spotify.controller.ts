import {
  createSpotifyAuthorizeUrl,
  disconnectSpotify,
  getCurrentlyPlaying,
  getOwnSpotifyConnection,
  getPublicSpotifyConnection,
  handleSpotifyOAuthCallback,
  spotifyNext,
  spotifyPause,
  spotifyPlay,
  spotifyPrevious,
  spotifySeek,
  updateShareSpotify,
} from "@mutualzz/util/SpotifyUser.ts";
import { resolveUserIdentifier } from "@mutualzz/util";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";
import { assertCanViewUserProfile } from "@mutualzz/util/privacy.ts";
import {
  oauthStartBody,
  spotifyOAuthCompleteBody,
  spotifyPatchBody,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "../../util/Validation";

export default class SpotifyController {
  static async startOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }

      const returnTo =
        oauthStartBody.parse(req.body ?? {}).returnTo ??
        `${process.env.FRONTEND_URL?.replace(/\/$/, "") ?? ""}/@me?spotify=connected`;

      const url = await createSpotifyAuthorizeUrl({
        userId: user.id,
        returnTo,
      });

      res.json({ url });
    } catch (err) {
      next(err);
    }
  }

  static async completeOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, state } = parseOrBadRequest(
        spotifyOAuthCompleteBody,
        req.body,
      );

      const returnTo = await handleSpotifyOAuthCallback({ code, state });
      res.json({ returnTo });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      res.json(await getOwnSpotifyConnection(user.id));
    } catch (err) {
      next(err);
    }
  }

  static async patchMe(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      const { shareSpotify } = parseOrBadRequest(spotifyPatchBody, req.body);
      res.json(await updateShareSpotify(user.id, shareSpotify));
    } catch (err) {
      next(err);
    }
  }

  static async deleteMe(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      await disconnectSpotify(user.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async currentlyPlaying(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      res.json(await getCurrentlyPlaying(user.id));
    } catch (err) {
      next(err);
    }
  }

  static async play(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      await spotifyPlay(user.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async pause(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      await spotifyPause(user.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async next(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      await spotifyNext(user.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async previous(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      await spotifyPrevious(user.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async seek(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      const positionMs = Number(req.body?.positionMs);
      if (!Number.isFinite(positionMs)) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "positionMs is required",
        );
      }
      await spotifySeek(user.id, positionMs);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }

  static async getPublic(req: Request, res: Response, next: NextFunction) {
    try {
      const identifierRaw = req.params.identifier;
      const identifier = Array.isArray(identifierRaw)
        ? identifierRaw[0]
        : identifierRaw;
      if (!identifier) {
        throw new HttpException(HttpStatusCode.BadRequest, "Missing user");
      }

      const target = await resolveUserIdentifier(identifier);
      if (!target) {
        throw new HttpException(HttpStatusCode.NotFound, "User not found");
      }

      await assertCanViewUserProfile(req.user?.id, target.id);

      const connection = await getPublicSpotifyConnection(target.id);
      if (!connection) {
        throw new HttpException(HttpStatusCode.NotFound, "Not found");
      }
      res.json(connection);
    } catch (err) {
      next(err);
    }
  }
}
