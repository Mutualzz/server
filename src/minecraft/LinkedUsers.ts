import { db, minecraftLinksTable, usersTable } from "@mutualzz/database";
import { inArray } from "drizzle-orm";

export interface LinkedMinecraftUser {
  userId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

const normalizeUuid = (uuid: string) => uuid.trim().toLowerCase();

/** Resolve Mutualzz accounts linked to the given Minecraft UUIDs. */
export const linkedUsersByMinecraftUuids = async (
  uuids: string[],
): Promise<Map<string, LinkedMinecraftUser>> => {
  const result = new Map<string, LinkedMinecraftUser>();
  if (uuids.length === 0) return result;

  const normalized = [...new Set(uuids.map(normalizeUuid).filter(Boolean))];
  if (normalized.length === 0) return result;

  const links = await db.query.minecraftLinksTable.findMany({
    where: inArray(minecraftLinksTable.minecraftUuid, normalized),
  });
  if (links.length === 0) return result;

  const userIds = links.map((l) => l.userId);
  const users = await db.query.usersTable.findMany({
    where: inArray(usersTable.id, userIds),
  });
  const usersById = new Map(users.map((u) => [u.id.toString(), u]));

  for (const link of links) {
    const user = usersById.get(link.userId.toString());
    if (!user) continue;
    const key = normalizeUuid(String(link.minecraftUuid));
    const mapped = {
      userId: user.id.toString(),
      username: user.username,
      globalName: user.globalName ?? null,
      avatar: user.avatar ?? null,
    };
    result.set(key, mapped);
    result.set(key.replace(/-/g, ""), mapped);
  }

  return result;
};
