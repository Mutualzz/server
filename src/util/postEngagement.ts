import {
  db,
  postCommentsTable,
  postLikesTable,
  postSavesTable,
  postSharesTable,
} from "@mutualzz/database";
import type { APIPost } from "@mutualzz/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveExpressions } from "./Helpers";

const toCountMap = (rows: { postId: bigint; count: number }[]) =>
  new Map(rows.map((row) => [row.postId.toString(), Number(row.count)]));

const toIdSet = (rows: { postId: bigint }[]) =>
  new Set(rows.map((row) => row.postId.toString()));

export const attachEngagementToPosts = async (
  posts: APIPost[],
  viewerUserId: string,
): Promise<APIPost[]> => {
  if (!posts.length) return posts;

  const postIds = posts.map((post) => BigInt(post.id));
  const viewerId = BigInt(viewerUserId);

  const [
    likeCounts,
    saveCounts,
    shareCounts,
    commentCounts,
    viewerLikes,
    viewerSaves,
    viewerShares,
  ] = await Promise.all([
    db
      .select({ postId: postLikesTable.postId, count: sql<number>`count(*)` })
      .from(postLikesTable)
      .where(inArray(postLikesTable.postId, postIds))
      .groupBy(postLikesTable.postId),
    db
      .select({ postId: postSavesTable.postId, count: sql<number>`count(*)` })
      .from(postSavesTable)
      .where(inArray(postSavesTable.postId, postIds))
      .groupBy(postSavesTable.postId),
    db
      .select({ postId: postSharesTable.postId, count: sql<number>`count(*)` })
      .from(postSharesTable)
      .where(inArray(postSharesTable.postId, postIds))
      .groupBy(postSharesTable.postId),
    db
      .select({
        postId: postCommentsTable.postId,
        count: sql<number>`count(*)`,
      })
      .from(postCommentsTable)
      .where(inArray(postCommentsTable.postId, postIds))
      .groupBy(postCommentsTable.postId),
    db
      .select({ postId: postLikesTable.postId })
      .from(postLikesTable)
      .where(
        and(
          inArray(postLikesTable.postId, postIds),
          eq(postLikesTable.userId, viewerId),
        ),
      ),
    db
      .select({ postId: postSavesTable.postId })
      .from(postSavesTable)
      .where(
        and(
          inArray(postSavesTable.postId, postIds),
          eq(postSavesTable.userId, viewerId),
        ),
      ),
    db
      .select({ postId: postSharesTable.postId })
      .from(postSharesTable)
      .where(
        and(
          inArray(postSharesTable.postId, postIds),
          eq(postSharesTable.userId, viewerId),
        ),
      ),
  ]);

  const likeMap = toCountMap(likeCounts);
  const saveMap = toCountMap(saveCounts);
  const shareMap = toCountMap(shareCounts);
  const commentMap = toCountMap(commentCounts);
  const likedSet = toIdSet(viewerLikes);
  const savedSet = toIdSet(viewerSaves);
  const sharedSet = toIdSet(viewerShares);

  return posts.map((post) => {
    const id = post.id.toString();

    return {
      ...post,
      likeCount: likeMap.get(id) ?? 0,
      saveCount: saveMap.get(id) ?? 0,
      shareCount: shareMap.get(id) ?? 0,
      commentCount: commentMap.get(id) ?? 0,
      liked: likedSet.has(id),
      saved: savedSet.has(id),
      shared: sharedSet.has(id),
    };
  });
};

export const attachExpressionsToPosts = async (
  posts: APIPost[],
): Promise<APIPost[]> => {
  if (!posts.length) return posts;

  return Promise.all(
    posts.map(async (post) => ({
      ...post,
      expressions: await resolveExpressions(post.content ?? null),
    })),
  );
};
