import { db, relationshipsTable } from "@mutualzz/database";
import { HttpException, HttpStatusCode, RelationshipType } from "@mutualzz/types";
import { and, eq, or } from "drizzle-orm";

export async function getBlockedUserIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      userId: relationshipsTable.userId,
      otherUserId: relationshipsTable.otherUserId,
    })
    .from(relationshipsTable)
    .where(
      and(
        eq(relationshipsTable.type, RelationshipType.Blocked),
        or(
          eq(relationshipsTable.userId, BigInt(userId)),
          eq(relationshipsTable.otherUserId, BigInt(userId)),
        ),
      ),
    );

  const blockedIds = new Set<string>();

  for (const row of rows) {
    blockedIds.add(
      row.userId.toString() === userId
        ? row.otherUserId.toString()
        : row.userId.toString(),
    );
  }

  return blockedIds;
}

export async function isBlockedBetween(
  userA: string,
  userB: string,
): Promise<boolean> {
  if (userA === userB) return false;

  const row = await db.query.relationshipsTable.findFirst({
    where: and(
      eq(relationshipsTable.type, RelationshipType.Blocked),
      or(
        and(
          eq(relationshipsTable.userId, BigInt(userA)),
          eq(relationshipsTable.otherUserId, BigInt(userB)),
        ),
        and(
          eq(relationshipsTable.userId, BigInt(userB)),
          eq(relationshipsTable.otherUserId, BigInt(userA)),
        ),
      ),
    ),
    columns: { id: true },
  });

  return !!row;
}

export async function assertNotBlocked(
  actorId: string,
  targetId: string,
  message = "User not found",
): Promise<void> {
  if (await isBlockedBetween(actorId, targetId)) {
    throw new HttpException(HttpStatusCode.NotFound, message);
  }
}

export async function assertUserVisible(
  viewerId: string,
  targetUserId: string,
): Promise<void> {
  if (viewerId === targetUserId) return;

  if (await isBlockedBetween(viewerId, targetUserId)) {
    throw new HttpException(HttpStatusCode.NotFound, "User not found");
  }
}

export function filterByBlockedAuthors<
  T extends { authorId: string | bigint | number },
>(items: T[], blockedIds: Set<string>): T[] {
  if (blockedIds.size === 0) return items;

  return items.filter((item) => !blockedIds.has(item.authorId.toString()));
}
