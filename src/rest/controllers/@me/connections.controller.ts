import {
  CONNECTION_PROVIDERS,
  connectionsHealth,
  createConnectionAuthorizeUrl,
  disconnectConnection,
  handleConnectionOAuthComplete,
  isConnectionProvider,
  listOwnConnections,
  listPublicConnections,
  updateConnectionShare,
} from "@mutualzz/util/connections/index.ts";
import { resolveUserIdentifier } from "@mutualzz/util";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { assertCanViewUserProfile } from "@mutualzz/util/privacy.ts";
import type { NextFunction, Request, Response } from "express";
import {
  connectionOAuthCompleteBody,
  connectionPatchBody,
  oauthStartBody,
} from "@mutualzz/validators";
import { parseOrBadRequest } from "../../util/Validation";

export default class ConnectionsController {
  static async listMine(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      res.json({
        providers: await listOwnConnections(user.id),
      });
    } catch (err) {
      next(err);
    }
  }

  static async health(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      res.json(connectionsHealth());
    } catch (err) {
      next(err);
    }
  }

  static async startOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }

      const providerRaw = req.params.provider;
      const provider = Array.isArray(providerRaw)
        ? providerRaw[0]
        : providerRaw;
      if (!provider || !isConnectionProvider(provider)) {
        throw new HttpException(HttpStatusCode.BadRequest, "Invalid provider");
      }

      const returnTo =
        oauthStartBody.parse(req.body ?? {}).returnTo ??
        `${process.env.FRONTEND_URL?.replace(/\/$/, "") ?? ""}/@me?connections=connected`;

      const { url } = await createConnectionAuthorizeUrl({
        userId: user.id,
        provider,
        returnTo,
      });
      res.json({ url });
    } catch (err) {
      next(err);
    }
  }

  static async completeOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const body = parseOrBadRequest(connectionOAuthCompleteBody, req.body);
      const { state, code, iss, openid } = body;
      const provider =
        body.provider && isConnectionProvider(body.provider)
          ? body.provider
          : undefined;

      const result = await handleConnectionOAuthComplete({
        provider,
        state,
        code,
        iss,
        openid,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async patch(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      const providerRaw = req.params.provider;
      const provider = Array.isArray(providerRaw)
        ? providerRaw[0]
        : providerRaw;
      if (!provider || !isConnectionProvider(provider)) {
        throw new HttpException(HttpStatusCode.BadRequest, "Invalid provider");
      }
      const { shareOnProfile } = parseOrBadRequest(
        connectionPatchBody,
        req.body,
      );
      res.json(await updateConnectionShare(user.id, provider, shareOnProfile));
    } catch (err) {
      next(err);
    }
  }

  static async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");
      }
      const providerRaw = req.params.provider;
      const provider = Array.isArray(providerRaw)
        ? providerRaw[0]
        : providerRaw;
      if (!provider || !isConnectionProvider(provider)) {
        throw new HttpException(HttpStatusCode.BadRequest, "Invalid provider");
      }
      await disconnectConnection(user.id, provider);
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

      res.json({
        connections: await listPublicConnections(target.id),
      });
    } catch (err) {
      next(err);
    }
  }

  static providers() {
    return CONNECTION_PROVIDERS;
  }
}
