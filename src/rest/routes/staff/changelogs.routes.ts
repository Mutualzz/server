import StaffChangelogsController from "@mutualzz/rest/controllers/staffChangelogs.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), StaffChangelogsController.list);
router.post("/", createLimiter(60_000, 20), StaffChangelogsController.create);
router.delete(
  "/:changelogId",
  createLimiter(60_000, 20),
  StaffChangelogsController.remove,
);

export default router;
