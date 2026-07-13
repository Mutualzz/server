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
import type { NextFunction, Request, Response } from "express";

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
        typeof req.body?.returnTo === "string" && req.body.returnTo.trim()
          ? req.body.returnTo.trim()
          : `${process.env.FRONTEND_URL?.replace(/\/$/, "") ?? ""}/@me?connections=connected`;

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
      const providerRaw =
        typeof req.body?.provider === "string" ? req.body.provider : "";
      const provider = isConnectionProvider(providerRaw)
        ? providerRaw
        : undefined;

      const state = typeof req.body?.state === "string" ? req.body.state : "";
      const code = typeof req.body?.code === "string" ? req.body.code : undefined;
      const iss = typeof req.body?.iss === "string" ? req.body.iss : undefined;

      let openid: Record<string, string> | undefined;
      if (req.body?.openid && typeof req.body.openid === "object") {
        openid = {};
        for (const [key, value] of Object.entries(
          req.body.openid as Record<string, unknown>,
        )) {
          if (typeof value === "string") openid[key] = value;
        }
      }

      if (!state) {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Missing code or state",
        );
      }

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
      if (typeof req.body?.shareOnProfile !== "boolean") {
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "shareOnProfile is required",
        );
      }
      res.json(
        await updateConnectionShare(
          user.id,
          provider,
          req.body.shareOnProfile,
        ),
      );
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
