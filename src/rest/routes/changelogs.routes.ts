import ChangelogsController from "@mutualzz/rest/controllers/changelogs.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/unseen", createLimiter(60_000, 60), ChangelogsController.unseen);
router.post(
  "/:changelogId/ack",
  createLimiter(60_000, 30),
  ChangelogsController.ack,
);

export default router;
