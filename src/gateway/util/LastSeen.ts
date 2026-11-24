import { db, usersTable } from "@mutualzz/database";
import { eq } from "drizzle-orm";
import { logger } from "../Logger";

export const touchLastSeen = async (userId?: string) => {
  if (!userId) return;

  try {
    await db
      .update(usersTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(usersTable.id, BigInt(userId)));
  } catch (error) {
    logger.error(error);
  }
};
