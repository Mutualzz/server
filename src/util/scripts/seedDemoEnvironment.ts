import "dotenv/config";

import { memberFlags, permissionFlags, roleFlags } from "@mutualzz/bitfield";
import {
  channelRecipientsTable,
  channelsTable,
  closeDatabase,
  db,
  messagesTable,
  postCommentsTable,
  postLikesTable,
  postsTable,
  relationshipsTable,
  rolesTable,
  spaceMemberRolesTable,
  spaceMembersTable,
  spacesTable,
  startDatabase,
  userProfilesTable,
  userSettingsTable,
  usersTable,
} from "@mutualzz/database";
import { BCRYPT_SALT_ROUNDS } from "@mutualzz/rest/util";
import { ChannelType, RelationshipType } from "@mutualzz/types";
import { genRandColor, Snowflake, syncPostHashtags } from "@mutualzz/util";
import { faker } from "@faker-js/faker";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import {
  assertDemoScriptSafeToRun,
  DEMO_EMAIL_DOMAIN,
  FRIEND_COUNT,
  HERO_EMAIL,
  HERO_GLOBAL_NAME,
  HERO_PASSWORD,
  HERO_USERNAME,
  wipeDemoData,
} from "./demoEnvironmentShared";

const ACCENT_COLORS = [
  "#5865f2",
  "#eb459e",
  "#57f287",
  "#fee75c",
  "#ed4245",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#3498db",
  "#f39c12",
];

const CURATED_POSTS: { authorOffset: number; content: string; hoursAgo: number }[] =
  [
    {
      authorOffset: 0,
      content:
        "finally finished my commission piece 🎨 really happy with how the lighting turned out #art #commissions",
      hoursAgo: 2,
    },
    {
      authorOffset: 1,
      content:
        "who else is staying up way too late reading webtoons instead of sleeping",
      hoursAgo: 5,
    },
    {
      authorOffset: 2,
      content:
        "new playlist drop — all darkwave and synth this week. link in bio #music #playlist",
      hoursAgo: 8,
    },
    {
      authorOffset: 3,
      content: "mutualzz voice hang last night was so good, we need to do that again",
      hoursAgo: 12,
    },
    {
      authorOffset: 4,
      content:
        "looking for moots who are into jrpg fanart and late-night gaming sessions 👾",
      hoursAgo: 18,
    },
    {
      authorOffset: 0,
      content:
        "slow morning coffee + sketching characters for a personal project ☕ #art",
      hoursAgo: 26,
    },
    {
      authorOffset: 5,
      content: "just discovered an amazing ambient artist, my ears are blessed #music",
      hoursAgo: 30,
    },
    {
      authorOffset: 6,
      content:
        "hot take: the best communities are the small ones where everyone actually talks",
      hoursAgo: 36,
    },
    {
      authorOffset: 7,
      content: "redid my profile layout, feeling cute might delete later ✨",
      hoursAgo: 42,
    },
    {
      authorOffset: 1,
      content:
        "working on a zine for next month — dm if you want to collab #art #zine",
      hoursAgo: 50,
    },
    {
      authorOffset: 8,
      content: "anyone else prefer feed mode or spaces mode? I keep switching lol",
      hoursAgo: 58,
    },
    {
      authorOffset: 9,
      content:
        "shoutout to everyone who checked in on me this week, y'all are real ones 💜",
      hoursAgo: 66,
    },
    {
      authorOffset: 2,
      content: "new sticker pack coming soon!! sneak peek in my space #creators",
      hoursAgo: 74,
    },
    {
      authorOffset: 0,
      content:
        "mutualzz is becoming my favorite place to post without the algorithm nonsense",
      hoursAgo: 82,
    },
    {
      authorOffset: 3,
      content: "late night thought: friendship > follower count, always",
      hoursAgo: 90,
    },
  ];

const SPACE_MESSAGES: { authorOffset: number; content: string; minutesAgo: number }[] =
  [
    { authorOffset: 1, content: "hey everyone! excited to be here 🎉", minutesAgo: 180 },
    { authorOffset: 0, content: "welcome in! drop your latest project in #art-share", minutesAgo: 175 },
    { authorOffset: 2, content: "just posted a new track in #music, would love feedback", minutesAgo: 120 },
    { authorOffset: 4, content: "this space already feels so cozy", minutesAgo: 90 },
    { authorOffset: 3, content: "anyone free for voice later tonight?", minutesAgo: 45 },
    { authorOffset: 5, content: "I'm down! been wanting to test the voice channels", minutesAgo: 40 },
    { authorOffset: 0, content: "same, let's do 9pm?", minutesAgo: 35 },
  ];

const DM_MESSAGES: { fromHero: boolean; content: string; minutesAgo: number }[] = [
  { fromHero: false, content: "yooo did you see the new profile widgets?", minutesAgo: 60 },
  { fromHero: true, content: "yes!! the music block is so clean now", minutesAgo: 55 },
  { fromHero: false, content: "right? I spent way too long customizing mine lol", minutesAgo: 50 },
  { fromHero: true, content: "worth it though, yours looks amazing", minutesAgo: 45 },
  { fromHero: false, content: "thanks 🥹 we should collab on something soon", minutesAgo: 40 },
  { fromHero: true, content: "absolutely — I have a zine idea actually", minutesAgo: 35 },
  { fromHero: false, content: "say less, send details whenever", minutesAgo: 30 },
  { fromHero: true, content: "will do! also are you joining voice tonight?", minutesAgo: 25 },
];

const DEMO_COMMENTS = [
  "this is so good!!",
  "obsessed with this",
  "need more posts like this",
  "literally saved this",
  "the vibes are immaculate",
];

type SeededUser = {
  id: bigint;
  username: string;
  email: string;
  globalName: string;
};

function hoursAgoDate(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function minutesAgoDate(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function createDemoUser(input: {
  username: string;
  email: string;
  globalName: string;
  password: string;
  accentColor: string;
  defaultAvatarType: number;
  preferredMode?: "spaces" | "feed";
}): Promise<SeededUser> {
  const id = BigInt(Snowflake.generate());
  const hash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS);

  await db.transaction(async (tx) => {
    await tx.insert(usersTable).values({
      id,
      username: input.username,
      email: input.email,
      globalName: input.globalName,
      hash,
      accentColor: input.accentColor,
      defaultAvatar: {
        type: input.defaultAvatarType,
        color: input.accentColor,
      },
      dateOfBirth: "1998-06-15",
    });

    await tx.insert(userSettingsTable).values({
      userId: id,
      preferredMode: input.preferredMode ?? "feed",
    });
  });

  return {
    id,
    username: input.username,
    email: input.email,
    globalName: input.globalName,
  };
}

async function makeFriends(heroId: bigint, friendIds: bigint[]) {
  for (const friendId of friendIds) {
    await db.insert(relationshipsTable).values([
      {
        id: BigInt(Snowflake.generate()),
        userId: heroId,
        otherUserId: friendId,
        type: RelationshipType.Friend,
      },
      {
        id: BigInt(Snowflake.generate()),
        userId: friendId,
        otherUserId: heroId,
        type: RelationshipType.Friend,
      },
    ]);
  }
}

async function seedPosts(users: SeededUser[]) {
  const createdPostIds: bigint[] = [];

  for (const post of CURATED_POSTS) {
    const author = users[post.authorOffset % users.length];
    const postId = BigInt(Snowflake.generate());
    const createdAt = hoursAgoDate(post.hoursAgo);

    await db.insert(postsTable).values({
      id: postId,
      authorId: author.id,
      content: post.content,
      createdAt,
      updatedAt: createdAt,
    });

    await syncPostHashtags(postId, post.content);
    createdPostIds.push(postId);
  }

  const heroId = users[0].id;
  const likeTargets = createdPostIds.slice(0, 8);

  for (const postId of likeTargets) {
    const likers = users.slice(1, 6);
    for (const liker of likers) {
      await db
        .insert(postLikesTable)
        .values({
          postId,
          userId: liker.id,
          createdAt: hoursAgoDate(1),
        })
        .onConflictDoNothing();
    }

    await db.insert(postLikesTable).values({
      postId,
      userId: heroId,
      createdAt: hoursAgoDate(1),
    }).onConflictDoNothing();
  }

  for (let i = 0; i < 4; i++) {
    const postId = createdPostIds[i];
    const commenter = users[(i + 2) % users.length];

    await db.insert(postCommentsTable).values({
      id: BigInt(Snowflake.generate()),
      postId,
      authorId: commenter.id,
      content: DEMO_COMMENTS[i],
      createdAt: hoursAgoDate(0.5),
      updatedAt: hoursAgoDate(0.5),
    });
  }

  console.log(`Seeded ${createdPostIds.length} posts with likes and comments.`);
}

async function seedSpace(hero: SeededUser, members: SeededUser[]) {
  const spaceId = BigInt(Snowflake.generate());

  await db.transaction(async (tx) => {
    await tx.insert(spacesTable).values({
      id: spaceId,
      name: "Alt Creators",
      description: "A space for artists, musicians, and night owls.",
      ownerId: hero.id,
      memberCount: members.length + 1,
    });

    const everyoneRoleId = spaceId;

    await tx.insert(rolesTable).values({
      id: everyoneRoleId,
      name: "@everyone",
      spaceId,
      flags: roleFlags.Everyone,
      allow:
        permissionFlags.ViewChannel |
        permissionFlags.SendMessages |
        permissionFlags.CreateInvites |
        permissionFlags.Connect |
        permissionFlags.Speak |
        permissionFlags.UseVAD |
        permissionFlags.AttachFiles |
        permissionFlags.ReadMessageHistory |
        permissionFlags.UseExternalEmojis |
        permissionFlags.UseExternalStickers |
        permissionFlags.EmbedLinks |
        permissionFlags.AddReactions |
        permissionFlags.ChangeNickname,
    });

    const allMembers = [hero, ...members.slice(0, 5)];

    for (const member of allMembers) {
      const isOwner = member.id === hero.id;

      await tx.insert(spaceMembersTable).values({
        spaceId,
        userId: member.id,
        flags: isOwner ? memberFlags.Owner : 0n,
      });

      await tx.insert(spaceMemberRolesTable).values({
        spaceId,
        userId: member.id,
        roleId: everyoneRoleId,
      });
    }

    const textCategoryId = BigInt(Snowflake.generate());
    await tx.insert(channelsTable).values({
      id: textCategoryId,
      type: ChannelType.Category,
      spaceId,
      name: "Text Channels",
      position: 0,
    });

    const generalChannelId = BigInt(Snowflake.generate());
    await tx.insert(channelsTable).values({
      id: generalChannelId,
      type: ChannelType.Text,
      spaceId,
      name: "general",
      position: 0,
      parentId: textCategoryId,
    });

    const artChannelId = BigInt(Snowflake.generate());
    await tx.insert(channelsTable).values({
      id: artChannelId,
      type: ChannelType.Text,
      spaceId,
      name: "art-share",
      position: 1,
      parentId: textCategoryId,
    });

    const voiceCategoryId = BigInt(Snowflake.generate());
    await tx.insert(channelsTable).values({
      id: voiceCategoryId,
      type: ChannelType.Category,
      spaceId,
      name: "Voice Channels",
      position: 1,
    });

    const voiceChannelId = BigInt(Snowflake.generate());
    await tx.insert(channelsTable).values({
      id: voiceChannelId,
      type: ChannelType.Voice,
      spaceId,
      name: "Lounge",
      position: 0,
      parentId: voiceCategoryId,
    });

    await tx
      .update(userSettingsTable)
      .set({ spacePositions: [spaceId] })
      .where(eq(userSettingsTable.userId, hero.id));

    const spaceParticipants = [hero, ...members.slice(0, 5)];

    for (const message of SPACE_MESSAGES) {
      const author =
        spaceParticipants[message.authorOffset % spaceParticipants.length];
      const createdAt = minutesAgoDate(message.minutesAgo);

      await tx.insert(messagesTable).values({
        id: BigInt(Snowflake.generate()),
        type: 0,
        authorId: author.id,
        channelId: generalChannelId,
        spaceId,
        content: message.content,
        createdAt,
        updatedAt: createdAt,
      });
    }
  });

  console.log('Seeded space "Alt Creators" with channels and messages.');
}

async function seedDirectMessages(hero: SeededUser, friend: SeededUser) {
  const channelId = BigInt(Snowflake.generate());

  await db.transaction(async (tx) => {
    await tx.insert(channelsTable).values({
      id: channelId,
      type: ChannelType.DM,
      flags: 0n,
      position: 0,
    });

    await tx.insert(channelRecipientsTable).values([
      { channelId, userId: hero.id },
      { channelId, userId: friend.id },
    ]);

    for (const message of DM_MESSAGES) {
      const authorId = message.fromHero ? hero.id : friend.id;
      const createdAt = minutesAgoDate(message.minutesAgo);

      await tx.insert(messagesTable).values({
        id: BigInt(Snowflake.generate()),
        type: 0,
        authorId,
        channelId,
        content: message.content,
        createdAt,
        updatedAt: createdAt,
      });
    }
  });

  console.log(`Seeded DM thread between ${hero.username} and ${friend.username}.`);
}

async function seedHeroProfile(hero: SeededUser) {
  await db
    .insert(userProfilesTable)
    .values({
      userId: hero.id,
      configured: true,
      backgroundColor: "#1a1020",
      bio: "Building connections for alt communities ✨ Artist · night owl · coffee enthusiast",
      mobileBlocks: [
        {
          id: "header",
          type: "header",
          size: "l",
          order: 0,
          bannerHeight: 180,
        },
        {
          id: "bio",
          type: "text",
          size: "m",
          order: 1,
          content:
            "Welcome to my corner of Mutualzz. I post art, music finds, and late-night thoughts.",
        },
        {
          id: "quote",
          type: "quote",
          size: "m",
          order: 2,
          content: "Small communities hit different.",
          variant: "accent",
          attribution: "me, every day",
        },
        {
          id: "links",
          type: "links",
          size: "s",
          order: 3,
          links: [
            { label: "Portfolio", url: "https://mutualzz.com" },
            { label: "Commissions open", url: "https://mutualzz.com" },
          ],
        },
      ],
      blocks: [],
    })
    .onConflictDoUpdate({
      target: userProfilesTable.userId,
      set: {
        configured: true,
        backgroundColor: "#1a1020",
        bio: "Building connections for alt communities ✨ Artist · night owl · coffee enthusiast",
        mobileBlocks: [
          {
            id: "header",
            type: "header",
            size: "l",
            order: 0,
            bannerHeight: 180,
          },
          {
            id: "bio",
            type: "text",
            size: "m",
            order: 1,
            content:
              "Welcome to my corner of Mutualzz. I post art, music finds, and late-night thoughts.",
          },
          {
            id: "quote",
            type: "quote",
            size: "m",
            order: 2,
            content: "Small communities hit different.",
            variant: "accent",
            attribution: "me, every day",
          },
          {
            id: "links",
            type: "links",
            size: "s",
            order: 3,
            links: [
              { label: "Portfolio", url: "https://mutualzz.com" },
              { label: "Commissions open", url: "https://mutualzz.com" },
            ],
          },
        ],
        updatedAt: new Date(),
      },
    });

  console.log("Seeded hero profile.");
}

async function main() {
  assertDemoScriptSafeToRun("seed");
  faker.seed(42);

  console.log("Connecting to database...");
  await startDatabase();

  console.log("Resetting previous demo data...");
  const removedUsers = await wipeDemoData();
  if (removedUsers.length > 0) {
    console.log(`Removed ${removedUsers.length} existing demo user(s).`);
  } else {
    console.log("No existing demo users to remove.");
  }

  console.log("Creating demo users...");
  const hero = await createDemoUser({
    username: HERO_USERNAME,
    email: HERO_EMAIL,
    globalName: HERO_GLOBAL_NAME,
    password: HERO_PASSWORD,
    accentColor: "#88449a",
    defaultAvatarType: 2,
    preferredMode: "feed",
  });

  const friends: SeededUser[] = [];
  for (let i = 1; i <= FRIEND_COUNT; i++) {
    const index = String(i).padStart(2, "0");
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();

    friends.push(
      await createDemoUser({
        username: `demo_friend_${index}`,
        email: `demo_friend_${index}@${DEMO_EMAIL_DOMAIN}`,
        globalName: `${firstName} ${lastName}`,
        password: HERO_PASSWORD,
        accentColor: ACCENT_COLORS[i % ACCENT_COLORS.length] ?? genRandColor(),
        defaultAvatarType: i % 5,
      }),
    );
  }

  const allUsers = [hero, ...friends];

  console.log("Creating friendships...");
  await makeFriends(hero.id, friends.map((friend) => friend.id));

  console.log("Seeding feed content...");
  await seedPosts(allUsers);

  console.log("Seeding space...");
  await seedSpace(hero, friends);

  console.log("Seeding direct messages...");
  await seedDirectMessages(hero, friends[0]);

  console.log("Seeding hero profile...");
  await seedHeroProfile(hero);

  console.log("\nDemo environment ready.\n");
  console.log("Screenshot / review account:");
  console.log(`  Email:    ${HERO_EMAIL}`);
  console.log(`  Username: ${HERO_USERNAME}`);
  console.log(`  Password: ${HERO_PASSWORD}`);
  console.log("\nLog in with this account to capture App Store screenshots.");
  console.log("Re-run `pnpm demo:seed` anytime to reset demo data.\n");
}

main()
  .catch((error) => {
    console.error("Demo seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
