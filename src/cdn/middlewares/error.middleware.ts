import { S3ServiceException } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { logger } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";

const errorMiddleware = (
    error: unknown,
    _: Request,
    res: Response,
    __: NextFunction,
) => {
    logger.error(error);

    if (error instanceof HttpException) {
        const { status, message, errors } = error;

        res.status(status).json({
            message,
            errors,
        });

        return;
    }

    if (error instanceof S3ServiceException) {
        if (error.$metadata.httpStatusCode === 404) {
            res.status(HttpStatusCode.NotFound).json({
                message: "Asset not found",
            });
            return;
        }
    }

    res.status(HttpStatusCode.InternalServerError).json({
        message: "Something went wrong",
    });
};

export default errorMiddleware;
