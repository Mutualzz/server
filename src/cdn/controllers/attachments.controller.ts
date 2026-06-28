import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bucketName, s3Client } from "@mutualzz/util";
import type { NextFunction, Request, Response } from "express";

export default class AttachmentsController {
  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { messageId, filename } = req.params as {
        messageId: string;
        filename: string;
      };

      const key = `attachments/${messageId}/${filename}`;

      let body: Uint8Array;
      let contentType: string | undefined;
      let contentLength: number | undefined;

      try {
        const result = await s3Client.send(
          new GetObjectCommand({ Bucket: bucketName, Key: key }),
        );
        if (!result.Body) throw new Error("Empty body");
        body = await result.Body.transformToByteArray();
        contentType = result.ContentType;
        contentLength = result.ContentLength;
      } catch {
        throw new HttpException(
          HttpStatusCode.NotFound,
          "Attachment not found",
        );
      }

      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader(
        "Content-Type",
        contentType || "application/octet-stream",
      );
      if (contentLength !== undefined)
        res.setHeader("Content-Length", contentLength);

      res.status(HttpStatusCode.Success).end(Buffer.from(body));
    } catch (err) {
      next(err);
    }
  }
}
