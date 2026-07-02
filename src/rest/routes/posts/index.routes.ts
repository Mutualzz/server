import PostsController from "@mutualzz/rest/controllers/posts/posts.controller";
import { createLimiter, createRouter } from "@mutualzz/util";
import { upload, scanUploads } from "@mutualzz/rest";
import PostCommentsController from "@mutualzz/rest/controllers/posts/postComments.controller";
import PostLikesController from "@mutualzz/rest/controllers/posts/postLikes.controller";
import PostSavesController from "@mutualzz/rest/controllers/posts/postSaves.controller";
import PostSharesController from "@mutualzz/rest/controllers/posts/postShares.controller";

const router = createRouter();

router.post(
  "/",
  createLimiter(5_000, 10),
  upload.array("attachments", 10),
  scanUploads,
  PostsController.create,
);

router.get(
  "/friends",
  createLimiter(60_000, 60),
  PostsController.getFriendsFeed,
);

router.get(
  "/for-you",
  createLimiter(60_000, 60),
  PostsController.getForYouFeed,
);

router.get(
  "/saved",
  createLimiter(60_000, 60),
  PostsController.getSavedFeed,
);

router.get(
  "/scheduled",
  createLimiter(60_000, 60),
  PostsController.getScheduledFeed,
);

router.get("/:postId", createLimiter(60_000, 60), PostsController.get);
router.patch("/:postId", createLimiter(60_000, 20), PostsController.update);
router.delete("/:postId", createLimiter(60_000, 20), PostsController.delete);

router.post(
  "/:postId/comments",
  createLimiter(5_000, 15),
  PostCommentsController.create,
);
router.get(
  "/:postId/comments",
  createLimiter(60_000, 60),
  PostCommentsController.getAll,
);
router.patch(
  "/:postId/comments/:commentId",
  createLimiter(60_000, 20),
  PostCommentsController.update,
);
router.delete(
  "/:postId/comments/:commentId",
  createLimiter(60_000, 20),
  PostCommentsController.delete,
);

router.put(
  "/:postId/likes/@me",
  createLimiter(5_000, 30),
  PostLikesController.add,
);
router.delete(
  "/:postId/likes/@me",
  createLimiter(5_000, 30),
  PostLikesController.remove,
);

router.put(
  "/:postId/saves/@me",
  createLimiter(5_000, 30),
  PostSavesController.add,
);
router.delete(
  "/:postId/saves/@me",
  createLimiter(5_000, 30),
  PostSavesController.remove,
);

router.post(
  "/:postId/shares/@me",
  createLimiter(5_000, 15),
  PostSharesController.add,
);
router.delete(
  "/:postId/shares/@me",
  createLimiter(5_000, 15),
  PostSharesController.remove,
);

export default router;
