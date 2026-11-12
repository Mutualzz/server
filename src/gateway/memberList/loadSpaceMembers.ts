import type {
  APISpaceMember,
  PresencePayload,
  Snowflake,
} from "@mutualzz/types";
import { db, spaceMembersTable } from "@mutualzz/database";
import { and, eq, inArray } from "drizzle-orm";
import { execNormalizedMany } from "@mutualzz/util";
import { PresenceService } from "../presence/Presence.service.ts";

export type HydratedSpaceMember = APISpaceMember & {
  presence: PresencePayload;
};

export const OFFLINE_PRESENCE: PresencePayload = {
  status: "offline",
  activities: [],
  device: "web",
  updatedAt: 0,
};

export async function loadSpaceMembers(
  spaceId: Snowflake,
  userIds: Snowflake[],
): Promise<Map<Snowflake, HydratedSpaceMember>> {
  const hydrated = new Map<Snowflake, HydratedSpaceMember>();
  if (!userIds.length) return hydrated;

  const [members, presences] = await Promise.all([
    execNormalizedMany<APISpaceMember>(
      db.query.spaceMembersTable.findMany({
        where: and(
          eq(spaceMembersTable.spaceId, BigInt(spaceId)),
          inArray(spaceMembersTable.userId, userIds.map(BigInt)),
        ),
        with: {
          user: {
            columns: {
              hash: false,
              dateOfBirth: false,
              previousAvatars: false,
              email: false,
            },
          },
          roles: { with: { role: true } },
        },
      }),
    ),
    PresenceService.getManyPublic(userIds),
  ]);

  for (const member of members ?? []) {
    const userId = String(member.userId);
    hydrated.set(userId, {
      ...member,
      roles:
        member.roles?.filter((memberRole) => memberRole.roleId !== spaceId) ??
        [],
      presence: presences.get(userId) ?? OFFLINE_PRESENCE,
    });
  }

  return hydrated;
}
