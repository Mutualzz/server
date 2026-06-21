import { HttpStatusCode } from "@mutualzz/types";
import { redis } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

const pushTokenKey = (userId: string) => `push-tokens:${userId}`;

const validatePushToken = z.object({
    token: z.string().min(1),
    platform: z.enum(["ios", "android", "web"]),
});

export default class PushTokenController {
    static async register(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            const { token, platform } = validatePushToken.parse(req.body);

            await redis.hset(pushTokenKey(user.id), platform, token);

            res.status(HttpStatusCode.NoContent).send();
        } catch (error) {
            next(error);
        }
    }

    static async remove(req: Request, res: Response, next: NextFunction) {
        try {
            const { user } = req;
            const { platform } = validatePushToken
                .pick({ platform: true })
                .parse(req.body);

            await redis.hdel(pushTokenKey(user.id), platform);

            res.status(HttpStatusCode.NoContent).send();
        } catch (error) {
            next(error);
        }
    }
}
