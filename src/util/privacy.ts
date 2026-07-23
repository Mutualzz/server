import { db, relationshipsTable, userSettingsTable } from "@mutualzz/database";
import {
  HttpException,
  HttpStatusCode,
  mergeExtendedSettings,
  RelationshipType,
} from "@mutualzz/types";
import { and, eq } from "drizzle-orm";

import { assertUserVisible } from "./blocks.ts";

export async function getExtendedSettings(userId: string) {
  const row = await db.query.userSettingsTable.findFirst({
    where: eq(userSettingsTable.userId, BigInt(userId)),
  });

  return mergeExtendedSettings(row?.extendedSettings ?? null);
}

export async function areFriends(
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const row = await db.query.relationshipsTable.findFirst({
    where: and(
      eq(relationshipsTable.userId, BigInt(userId)),
      eq(relationshipsTable.otherUserId, BigInt(otherUserId)),
      eq(relationshipsTable.type, RelationshipType.Friend),
    ),
  });

  return !!row;
}

export async function assertCanDm(recipientId: string, senderId: string) {
  if (String(recipientId) === String(senderId)) return;

  const settings = await getExtendedSettings(recipientId);

  if (settings.whoCanDm === "everyone") return;

  if (settings.whoCanDm === "nobody") {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "This user is not accepting direct messages",
    );
  }

  if (!(await areFriends(recipientId, senderId))) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "This user is only accepting direct messages from friends",
    );
  }
}

const sameUser = (
  viewerId: string | undefined,
  targetId: string,
) => !!viewerId && String(viewerId) === String(targetId);

export async function assertCanViewUserProfile(
  viewerId: string | undefined,
  targetId: string,
) {
  if (sameUser(viewerId, targetId)) return;

  if (viewerId) {
    await assertUserVisible(viewerId, targetId);
  }
  await assertProfileVisible(viewerId, targetId);
}

export async function canViewerDmTarget(
  viewerId: string | undefined,
  targetId: string,
): Promise<boolean> {
  if (!viewerId || sameUser(viewerId, targetId)) return true;

  try {
    await assertCanDm(targetId, viewerId);
    return true;
  } catch {
    return false;
  }
}

export async function assertProfileVisible(
  viewerId: string | undefined,
  targetId: string,
) {
  if (sameUser(viewerId, targetId)) return;

  const settings = await getExtendedSettings(targetId);

  if (settings.profileVisibility === "everyone") return;

  if (!viewerId || settings.profileVisibility === "nobody") {
    throw new HttpException(HttpStatusCode.NotFound, "User not found");
  }

  if (!(await areFriends(targetId, viewerId))) {
    throw new HttpException(HttpStatusCode.NotFound, "User not found");
  }
}
