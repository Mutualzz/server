import { db, hashtagsTable, postHashtagsTable } from "@mutualzz/database";
import { eq, inArray, sql } from "drizzle-orm";
import { Snowflake } from "./Snowflake";
import type { APIHashtag, APIPost } from "@mutualzz/types";

const HASHTAG_REGEX = /#([a-zA-Z0-9_]+)/g;

export const extractHashtags = (content?: string | null) => {
  if (!content) return [];

  return [
    ...new Set(
      [...content.matchAll(HASHTAG_REGEX)].map((match) =>
        match[1].toLowerCase(),
      ),
    ),
  ];
};

export const syncPostHashtags = async (
  postId: bigint,
  content?: string | null,
): Promise<APIHashtag[]> => {
  await db
    .delete(postHashtagsTable)
    .where(eq(postHashtagsTable.postId, postId));

  const tags = extractHashtags(content);
  if (tags.length === 0) return [];

  const hashtags = await db
    .insert(hashtagsTable)
    .values(tags.map((tag) => ({ id: BigInt(Snowflake.generate()), tag })))
    .onConflictDoUpdate({
      target: hashtagsTable.tag,
      set: { tag: sql`excluded.tag` },
    })
    .returning();

  await db.insert(postHashtagsTable).values(
    hashtags.map((hashtag) => ({
      postId,
      hashtagId: hashtag.id,
    })),
  );

  return hashtags.map((h) => ({ id: h.id.toString(), tag: h.tag }));
};

export const attachHashtagsToPosts = async (
  posts: APIPost[],
): Promise<APIPost[]> => {
  if (!posts.length) return posts;

  const postIds = posts.map((post) => BigInt(post.id));

  const rows = await db
    .select({ postId: postHashtagsTable.postId, hashtag: hashtagsTable })
    .from(postHashtagsTable)
    .innerJoin(hashtagsTable, eq(postHashtagsTable.hashtagId, hashtagsTable.id))
    .where(inArray(postHashtagsTable.postId, postIds));

  const grouped = new Map<string, APIHashtag[]>();
  for (const row of rows) {
    const key = row.postId.toString();
    const list = grouped.get(key) ?? [];
    list.push({ id: row.hashtag.id.toString(), tag: row.hashtag.tag });
    grouped.set(key, list);
  }

  return posts.map((post) => ({
    ...post,
    hashtags: grouped.get(post.id.toString()) ?? [],
  }));
};
