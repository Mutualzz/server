import { logger } from "@mutualzz/rest/Logger";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

const errorMiddleware = (
    error: unknown,
    _: Request,
    res: Response,
    __: NextFunction,
) => {
    logger.error(error);
    let constructedError;

    if (error instanceof HttpException) {
        const { status, message, errors } = error;

        constructedError = {
            status,
            message,
            errors,
        };
    }

    if (error instanceof ZodError) {
        const errors = error.issues.map((err) => ({
            path: err.path[0]?.toString() ?? "unknown",
            message: err.message,
        }));

        constructedError = {
            status: HttpStatusCode.BadRequest,
            message: "Invalid request data",
            errors,
        };
    }

    if (!constructedError) {
        constructedError = {
            status: HttpStatusCode.InternalServerError,
            message: "Something went wrong",
        };
    }

    logger.error(constructedError);

    res.status(constructedError.status).json({
        message: constructedError.message,
        errors: constructedError.errors,
    });
};

export default errorMiddleware;
