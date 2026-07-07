import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  deleteCache,
  getCache,
  invalidateCache,
  setCache,
} from "@mutualzz/cache";
import { db, postSavesTable, postsTable } from "@mutualzz/database";
import {
  HttpException,
  HttpStatusCode,
  type APIAttachment,
  type APIMessageEmbed,
  type APIPost,
} from "@mutualzz/types";
import {
  attachEngagementToPosts,
  attachExpressionsToPosts,
  attachHashtagsToPosts,
  buildEmbeds,
  bucketName,
  emitEvent,
  execNormalized,
  execNormalizedMany,
  fireAndForgetAll,
  getFriendIds,
  publicUserColumns,
  resolveExpressions,
  s3Client,
  sanitizeContent,
  Snowflake,
  syncPostHashtags,
} from "@mutualzz/util";
import {
  validatePostBodyPatch,
  validatePostBodyPut,
  validatePostParams,
} from "@mutualzz/validators";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";

const MAX_SCHEDULE_MS = 90 * 24 * 60 * 60 * 1000;

function parseScheduledFor(raw: string): Date {
  const date = new Date(raw);

  if (isNaN(date.getTime()))
    throw new HttpException(HttpStatusCode.BadRequest, "Invalid scheduled date");

  if (date.getTime() <= Date.now())
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Scheduled date must be in the future",
    );

  if (date.getTime() > Date.now() + MAX_SCHEDULE_MS)
    throw new HttpException(
      HttpStatusCode.BadRequest,
      "Cannot schedule a post more than 90 days ahead",
    );

  return date;
}

function isUnpublished(post: Pick<APIPost, "scheduledFor">): boolean {
  return !!post.scheduledFor && new Date(post.scheduledFor) > new Date();
}

function publishedFilter() {
  return or(
    isNull(postsTable.scheduledFor),
    lte(postsTable.scheduledFor, new Date()),
  );
}

export default class PostsController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const {
        content,
        scheduledFor,
        expressionIds = [],
      } = validatePostBodyPut.parse(req.body);

      const uploadedFiles: Express.Multer.File[] = Array.isArray(req.files)
        ? req.files
        : [];

      if (!content && uploadedFiles.length === 0 && expressionIds.length === 0)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Post must have content, stickers, or attachments",
        );

      const scheduledForDate = scheduledFor
        ? parseScheduledFor(scheduledFor)
        : undefined;

      const postId = BigInt(Snowflake.generate());

      const allUploaded: APIAttachment[] = await Promise.all(
        uploadedFiles.map(async (file) => {
          const attachmentId = Snowflake.generate();
          const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
          const key = `attachments/${postId}/${attachmentId}_${safeName}`;

          await s3Client.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Body: file.buffer,
              Key: key,
              ContentType: file.mimetype,
            }),
          );

          let width: number | undefined;
          let height: number | undefined;
          if (file.mimetype.startsWith("image/")) {
            try {
              const meta = await sharp(file.buffer).metadata();
              width = meta.width;
              height = meta.height;
            } catch {
              // ignore dimension errors
            }
          }

          const cdnBase = process.env.CDN_URL ?? "";
          return {
            id: attachmentId,
            filename: file.originalname,
            size: file.size,
            contentType: file.mimetype,
            url: `${cdnBase}/${key}`,
            width,
            height,
          } satisfies APIAttachment;
        }),
      );

      // GIF uploads become gifv embeds so they work with the gif picker
      const attachments = allUploaded.filter(
        (a) => a.contentType !== "image/gif",
      );
      const gifEmbeds: APIMessageEmbed[] = allUploaded
        .filter((a) => a.contentType === "image/gif")
        .map((gif) => ({
          type: "gifv",
          url: gif.url,
          media: gif.url,
          image: gif.url,
          title: gif.filename,
        }));

      const sanitizedContent = content
        ? await sanitizeContent(content, null, user.id, false)
        : null;

      const contentEmbeds = await buildEmbeds(sanitizedContent || "");
      const embeds = [...contentEmbeds, ...gifEmbeds];

      const validatedExpressionIds = [...new Set(expressionIds)].map((id) =>
        BigInt(id),
      );

      const newPost = await execNormalized<APIPost>(
        db
          .insert(postsTable)
          .values({
            id: postId,
            authorId: BigInt(user.id),
            content: sanitizedContent,
            attachments,
            embeds,
            expressionIds: validatedExpressionIds,
            scheduledFor: scheduledForDate,
          })
          .returning()
          .then((r) => (r.length > 0 ? r[0] : null)),
      );

      if (!newPost)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create post",
        );

      const [hashtags, expressions] = await Promise.all([
        syncPostHashtags(postId, sanitizedContent),
        resolveExpressions(sanitizedContent, newPost.expressionIds),
      ]);

      const post: APIPost = {
        ...newPost,
        author: user,
        attachments,
        hashtags,
        expressions,
        likeCount: 0,
        saveCount: 0,
        shareCount: 0,
        commentCount: 0,
        liked: false,
        saved: false,
        shared: false,
      };

      res.status(HttpStatusCode.Created).json(post);

      fireAndForgetAll([
        {
          label: "event:PostCreate",
          run: async () => {
            if (isUnpublished(post)) return;

            const friendIds = await getFriendIds(user.id);

            await Promise.all(
              [user.id, ...friendIds].map((id) =>
                emitEvent({
                  event: "PostCreate",
                  user_id: id,
                  data: post,
                }),
              ),
            );
          },
        },
        {
          label: "cache:set:post",
          run: () => setCache("post", post.id, post),
        },
        {
          label: "cache:invalidate:posts",
          run: () => invalidateCache("posts", user.id),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId } = validatePostParams.parse(req.params);

      let post = await getCache("post", postId);
      if (!post) {
        const fetched = await execNormalized<APIPost>(
          db.query.postsTable.findFirst({
            with: {
              author: { columns: publicUserColumns },
            },
            where: eq(postsTable.id, BigInt(postId)),
          }),
        );

        if (!fetched)
          throw new HttpException(HttpStatusCode.NotFound, "Post not found");

        const [withHashtags] = await attachHashtagsToPosts([fetched]);
        post = withHashtags;

        void setCache("post", postId, post);
      }

      if (isUnpublished(post) && BigInt(post.authorId) !== BigInt(user.id))
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      const [engaged] = await attachEngagementToPosts([post], user.id);
      const [hydrated] = await attachExpressionsToPosts([engaged]);

      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async getFriendsFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const beforeRaw = req.query.before ? `${req.query.before}` : undefined;
      const afterRaw = req.query.after ? `${req.query.after}` : undefined;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 50));

      if (beforeRaw && afterRaw)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot use both before and after",
        );

      const friendIds = await getFriendIds(user.id);
      const authorIds = [BigInt(user.id), ...friendIds.map((id) => BigInt(id))];

      let posts: APIPost[];

      if (beforeRaw) {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.authorId, authorIds),
              lt(postsTable.id, BigInt(beforeRaw)),
              publishedFilter(),
            ),
            orderBy: desc(postsTable.createdAt),
            limit,
          }),
        );
      } else if (afterRaw) {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.authorId, authorIds),
              gte(postsTable.id, BigInt(afterRaw)),
              publishedFilter(),
            ),
            orderBy: asc(postsTable.createdAt),
            limit,
          }),
        );
      } else {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.authorId, authorIds),
              publishedFilter(),
            ),
            orderBy: desc(postsTable.createdAt),
            limit,
          }),
        );
      }

      const withHashtags = await attachHashtagsToPosts(posts);
      const engaged = await attachEngagementToPosts(withHashtags, user.id);
      const hydrated = await attachExpressionsToPosts(engaged);

      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId } = validatePostParams.parse(req.params);

      let post = await getCache("post", postId);
      if (!post)
        post = await execNormalized<APIPost>(
          db.query.postsTable.findFirst({
            with: { author: { columns: publicUserColumns } },
            where: eq(postsTable.id, BigInt(postId)),
          }),
        );

      if (!post)
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      if (BigInt(post.authorId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You can only edit your own posts",
        );

      const { content, scheduledFor } = validatePostBodyPatch.parse(req.body);

      const finalContent = content !== undefined ? content : post.content;
      const hasAttachments = (post.attachments?.length ?? 0) > 0;
      if (!finalContent && !hasAttachments)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Post must have content or attachments",
        );

      const sanitizedContent =
        content !== undefined
          ? content
            ? await sanitizeContent(content, null, user.id, false)
            : null
          : undefined;

      const wasScheduled = isUnpublished(post);

      const scheduledForUpdate: Date | null | undefined =
        scheduledFor !== undefined
          ? scheduledFor === null
            ? null
            : parseScheduledFor(scheduledFor)
          : undefined;

      const willBeScheduled =
        scheduledForUpdate !== undefined
          ? !!scheduledForUpdate && scheduledForUpdate.getTime() > Date.now()
          : wasScheduled;

      const result = await execNormalized<APIPost>(
        db
          .update(postsTable)
          .set({
            ...(sanitizedContent !== undefined
              ? { content: sanitizedContent }
              : {}),
            ...(scheduledForUpdate !== undefined
              ? { scheduledFor: scheduledForUpdate }
              : {}),
          })
          .where(eq(postsTable.id, BigInt(postId)))
          .returning()
          .then((r) => (r.length > 0 ? r[0] : null)),
      );

      if (!result)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update post",
        );

      const [hashtags, expressions] = await Promise.all([
        syncPostHashtags(BigInt(postId), result.content),
        resolveExpressions(result.content ?? null, result.expressionIds),
      ]);

      const updatedPost: APIPost = {
        ...result,
        author: post.author,
        hashtags,
        expressions,
      };

      const [hydrated] = await attachEngagementToPosts([updatedPost], user.id);

      res.status(HttpStatusCode.Success).json(hydrated);

      const nowLive = wasScheduled && !willBeScheduled;

      fireAndForgetAll([
        {
          label: nowLive ? "event:PostCreate" : "event:PostUpdate",
          run: async () => {
            if (willBeScheduled) return;

            const friendIds = await getFriendIds(user.id);

            await Promise.all(
              [user.id, ...friendIds].map((id) =>
                emitEvent({
                  event: nowLive ? "PostCreate" : "PostUpdate",
                  user_id: id,
                  data: updatedPost,
                }),
              ),
            );
          },
        },
        {
          label: "cache:set:post",
          run: () => setCache("post", updatedPost.id, updatedPost),
        },
        {
          label: "cache:invalidate:posts",
          run: () => invalidateCache("posts", user.id),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { postId } = validatePostParams.parse(req.params);

      const post = await execNormalized<APIPost>(
        db.query.postsTable.findFirst({
          where: eq(postsTable.id, BigInt(postId)),
        }),
      );

      if (!post)
        throw new HttpException(HttpStatusCode.NotFound, "Post not found");

      if (BigInt(post.authorId) !== BigInt(user.id))
        throw new HttpException(
          HttpStatusCode.Forbidden,
          "You can only delete your own posts",
        );

      await db.delete(postsTable).where(eq(postsTable.id, BigInt(postId)));

      res.status(HttpStatusCode.Success).json({ id: post.id });

      fireAndForgetAll([
        {
          label: "event:PostDelete",
          run: async () => {
            const notifyIds = isUnpublished(post)
              ? [user.id]
              : [user.id, ...(await getFriendIds(user.id))];

            await Promise.all(
              notifyIds.map((id) =>
                emitEvent({
                  event: "PostDelete",
                  user_id: id,
                  data: { id: post.id },
                }),
              ),
            );
          },
        },
        {
          label: "cache:delete:post",
          run: () => deleteCache("post", postId),
        },
        {
          label: "cache:invalidate:posts",
          run: () => invalidateCache("posts", user.id),
        },
      ]);
    } catch (err) {
      next(err);
    }
  }

  static async getForYouFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 50));

      const windowStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      const candidates = await execNormalizedMany<APIPost>(
        db.query.postsTable.findMany({
          with: { author: { columns: publicUserColumns } },
          where: and(
            gte(postsTable.createdAt, windowStart),
            publishedFilter(),
          ),
          orderBy: desc(postsTable.createdAt),
          limit: 500,
        }),
      );

      const [withHashtags, friendIds] = await Promise.all([
        attachHashtagsToPosts(candidates),
        getFriendIds(user.id),
      ]);

      const hydrated = await attachEngagementToPosts(withHashtags, user.id);

      const friendSet = new Set(friendIds);
      const now = Date.now();

      const scored = hydrated.map((post) => {
        const hoursSinceCreated = Math.max(
          0,
          (now - new Date(post.createdAt).getTime()) / (1000 * 60 * 60),
        );

        const engagementWeight =
          1 +
          (post.likeCount ?? 0) * 1 +
          (post.commentCount ?? 0) * 1.5 +
          (post.shareCount ?? 0) * 2.5;

        const decay = 1 / (hoursSinceCreated + 2) ** 1.5;
        const friendBoost = friendSet.has(post.authorId) ? 1.5 : 1;

        return { post, score: engagementWeight * decay * friendBoost };
      });

      scored.sort((a, b) => b.score - a.score);

      const start = (page - 1) * limit;
      const paginated = scored.slice(start, start + limit).map((s) => s.post);
      const withExpressions = await attachExpressionsToPosts(paginated);

      res.status(HttpStatusCode.Success).json(withExpressions);
    } catch (err) {
      next(err);
    }
  }

  static async getSavedFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const beforeRaw = req.query.before ? `${req.query.before}` : undefined;
      const afterRaw = req.query.after ? `${req.query.after}` : undefined;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 50));

      if (beforeRaw && afterRaw)
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "Cannot use both before and after",
        );

      const savedRows = await db
        .select({ postId: postSavesTable.postId })
        .from(postSavesTable)
        .where(eq(postSavesTable.userId, BigInt(user.id)));

      const savedPostIds = savedRows.map((row) => row.postId);

      if (savedPostIds.length === 0) {
        res.status(HttpStatusCode.Success).json([]);
        return;
      }

      let posts: APIPost[];

      if (beforeRaw) {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.id, savedPostIds),
              lt(postsTable.id, BigInt(beforeRaw)),
              publishedFilter(),
            ),
            orderBy: desc(postsTable.createdAt),
            limit,
          }),
        );
      } else if (afterRaw) {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.id, savedPostIds),
              gte(postsTable.id, BigInt(afterRaw)),
              publishedFilter(),
            ),
            orderBy: asc(postsTable.createdAt),
            limit,
          }),
        );
      } else {
        posts = await execNormalizedMany<APIPost>(
          db.query.postsTable.findMany({
            with: { author: { columns: publicUserColumns } },
            where: and(
              inArray(postsTable.id, savedPostIds),
              publishedFilter(),
            ),
            orderBy: desc(postsTable.createdAt),
            limit,
          }),
        );
      }

      const withHashtags = await attachHashtagsToPosts(posts);
      const engaged = await attachEngagementToPosts(withHashtags, user.id);
      const hydrated = await attachExpressionsToPosts(engaged);

      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }

  static async getScheduledFeed(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));

      const posts = await execNormalizedMany<APIPost>(
        db.query.postsTable.findMany({
          where: and(
            eq(postsTable.authorId, BigInt(user.id)),
            gte(postsTable.scheduledFor, new Date()),
          ),
          orderBy: asc(postsTable.scheduledFor),
          limit,
        }),
      );

      const withHashtags = await attachHashtagsToPosts(posts);
      const hydrated = await attachExpressionsToPosts(withHashtags);

      res.status(HttpStatusCode.Success).json(hydrated);
    } catch (err) {
      next(err);
    }
  }
}
