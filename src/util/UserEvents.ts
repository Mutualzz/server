import {
  channelRecipientsTable,
  db,
  spaceMembersTable,
  toPublicUser,
} from "@mutualzz/database";
import type { APIPrivateUser } from "@mutualzz/types";
import { eq } from "drizzle-orm";
import { emitEvent } from "./RabbitMQ";

export async function emitUserUpdate(user: APIPrivateUser) {
  const userId = BigInt(user.id);
  const publicUser = toPublicUser({ ...user });

  const [memberships, dmChannels] = await Promise.all([
    db
      .select({ spaceId: spaceMembersTable.spaceId })
      .from(spaceMembersTable)
      .where(eq(spaceMembersTable.userId, userId)),
    db
      .select({ channelId: channelRecipientsTable.channelId })
      .from(channelRecipientsTable)
      .where(eq(channelRecipientsTable.userId, userId)),
  ]);

  await Promise.all([
    emitEvent({ event: "UserUpdate", user_id: user.id, data: user }),
    ...memberships.map(({ spaceId }) =>
      emitEvent({
        event: "UserUpdate",
        space_id: String(spaceId),
        data: publicUser,
      }),
    ),
    ...dmChannels.map(({ channelId }) =>
      emitEvent({
        event: "UserUpdate",
        channel_id: String(channelId),
        data: publicUser,
      }),
    ),
  ]);
}
