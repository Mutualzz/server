import { S3ServiceException } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../Logger";

const errorMiddleware = (
    error: unknown,
    _: Request,
    res: Response,
    __: NextFunction,
) => {
    let constructedError;

    if (error instanceof HttpException) {
        const { status, message, errors } = error;

        constructedError = { status, message, errors };
    }

    if (error instanceof S3ServiceException) {
        if (error.$metadata.httpStatusCode === 404) {
            constructedError = {
                status: HttpStatusCode.NotFound,
                message: "Asset not found",
            };
        }
    }

    if (!constructedError) {
        constructedError = {
            status: HttpStatusCode.InternalServerError,
            message: "Something went wrong",
        };
    }

    logger.error(error);
    res.status(constructedError.status).json({
        message: constructedError.message,
    });
};

export default errorMiddleware;
