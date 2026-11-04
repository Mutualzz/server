import ApplicationsController from "@mutualzz/rest/controllers/applications.controller.ts";
import { scanUploads, upload } from "@mutualzz/rest";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

// "/@me" must come before "/:applicationId"
router.get("/@me", createLimiter(60_000, 30), ApplicationsController.listMine);
router.post("/", createLimiter(60_000, 10), ApplicationsController.create);
router.get(
  "/:applicationId",
  createLimiter(60_000, 120),
  ApplicationsController.get,
);
router.patch(
  "/:applicationId",
  createLimiter(60_000, 30),
  ApplicationsController.update,
);
router.put(
  "/:applicationId/icon",
  createLimiter(60_000, 20),
  upload.single("icon"),
  scanUploads,
  ApplicationsController.putIcon,
);
router.delete(
  "/:applicationId/icon",
  createLimiter(60_000, 20),
  ApplicationsController.deleteIcon,
);
router.delete(
  "/:applicationId",
  createLimiter(60_000, 20),
  ApplicationsController.delete,
);

export default router;
