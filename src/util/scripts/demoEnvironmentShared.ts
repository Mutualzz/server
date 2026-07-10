import {
  channelRecipientsTable,
  channelsTable,
  db,
  spacesTable,
  usersTable,
} from "@mutualzz/database";
import { ChannelType } from "@mutualzz/types";
import { and, eq, inArray, like, or } from "drizzle-orm";

export const DEMO_EMAIL_DOMAIN = "demo.mutualzz.internal";
export const HERO_EMAIL = "screenshots@mutualzz.com";
export const HERO_USERNAME = "mutualzz";
export const HERO_PASSWORD = "ScreenshotDemo2026!";
export const HERO_GLOBAL_NAME = "Mutualzz";
export const FRIEND_COUNT = 10;

export function assertDemoScriptSafeToRun(action: "seed" | "clean") {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_DEMO_SEED_ON_PRODUCTION !== "true"
  ) {
    console.error(
      `Refusing to ${action} demo data in production. Set ALLOW_DEMO_SEED_ON_PRODUCTION=true to override.`,
    );
    process.exit(1);
  }

  if (!process.env.DATABASE) {
    console.error("DATABASE env var is required.");
    process.exit(1);
  }
}

export type DemoUserSummary = {
  id: bigint;
  username: string;
  email: string;
};

export async function findDemoUsers(): Promise<DemoUserSummary[]> {
  return db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(
      or(
        like(usersTable.email, `%@${DEMO_EMAIL_DOMAIN}`),
        eq(usersTable.email, HERO_EMAIL),
        like(usersTable.username, "demo_friend_%"),
      ),
    );
}

export async function wipeDemoData(): Promise<DemoUserSummary[]> {
  const demoUsers = await findDemoUsers();

  if (demoUsers.length === 0) return [];

  const demoUserIds = demoUsers.map((user) => user.id);

  const dmChannels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .innerJoin(
      channelRecipientsTable,
      eq(channelRecipientsTable.channelId, channelsTable.id),
    )
    .where(
      and(
        eq(channelsTable.type, ChannelType.DM),
        inArray(channelRecipientsTable.userId, demoUserIds),
      ),
    );

  const dmChannelIds = [...new Set(dmChannels.map((channel) => channel.id))];

  if (dmChannelIds.length > 0) {
    await db.delete(channelsTable).where(inArray(channelsTable.id, dmChannelIds));
  }

  await db
    .delete(spacesTable)
    .where(inArray(spacesTable.ownerId, demoUserIds));

  await db.delete(usersTable).where(inArray(usersTable.id, demoUserIds));

  return demoUsers;
}
