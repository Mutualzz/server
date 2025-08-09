import { HttpStatusCode } from "@mutualzz/types";
import { type NextFunction, type Request, type Response } from "express";

export default class MainController {
    static ack(_: Request, res: Response, __: NextFunction) {
        res.status(HttpStatusCode.Success).json({
            ack: true,
        });
    }
}
