import { HttpException, HttpStatusCode } from "@mutualzz/types";
import type { z } from "zod";

// Like schema.parse(), but the 400 carries the first issue's message instead of the
// error middleware's generic "Invalid request data", for screens that show err.message
export const parseOrBadRequest = <T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.output<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpException(
      HttpStatusCode.BadRequest,
      result.error.issues[0]?.message ?? "Invalid request data",
    );
  }
  return result.data;
};
