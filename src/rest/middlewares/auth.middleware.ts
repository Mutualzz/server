import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { getUser } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "../utils";

const { JWT_SECRET } = process.env;
if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined");

const authMiddleware = async (
    req: Request,
    _: Response,
    next: NextFunction,
) => {
    try {
        if (!req.headers.authorization) return next();

        const token = req.headers.authorization.split(" ")[1] ?? null;
        if (!token)
            throw new HttpException(
                HttpStatusCode.Unauthorized,
                "Unauthorized",
            );

        const session = await verifySessionToken(token);
        if (!session)
            throw new HttpException(
                HttpStatusCode.Unauthorized,
                "Unauthorized",
            );

        const user = await getUser(session.userId);
        if (!user)
            throw new HttpException(
                HttpStatusCode.Unauthorized,
                "Unauthorized",
            );

        req.user = {
            ...user,
            token,
        };

        next();
    } catch (err) {
        next(err);
    }
};

export default authMiddleware;
