import {
  db,
  spaceMembersTable,
  userProfilesTable,
  userProfileVersionsTable,
} from "@mutualzz/database";
import { eq } from "drizzle-orm";
import type { ProfileAssetSource } from "./profileAssets";

export const loadUserAssetKeepSources = async (
  userId: string,
): Promise<ProfileAssetSource[]> => {
  const userKey = BigInt(userId);

  const [profile, versions, memberships] = await Promise.all([
    db.query.userProfilesTable.findFirst({
      where: eq(userProfilesTable.userId, userKey),
    }),
    db
      .select({ snapshot: userProfileVersionsTable.snapshot })
      .from(userProfileVersionsTable)
      .where(eq(userProfileVersionsTable.userId, userKey)),
    db
      .select({
        avatar: spaceMembersTable.avatar,
        banner: spaceMembersTable.banner,
      })
      .from(spaceMembersTable)
      .where(eq(spaceMembersTable.userId, userKey)),
  ]);

  const memberImages = memberships.flatMap((membership) =>
    [membership.avatar, membership.banner].filter(
      (hash): hash is string => !!hash,
    ),
  );

  return [
    ...(profile ? [profile] : []),
    ...versions.map((version) => version.snapshot),
    { images: memberImages },
  ];
};
