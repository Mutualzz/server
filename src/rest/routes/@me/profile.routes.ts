import { upload, scanUploads } from "@mutualzz/rest";
import ProfileController from "@mutualzz/rest/controllers/@me/profile.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), ProfileController.getMe);
router.put("/", createLimiter(60_000, 20), ProfileController.update);
router.post(
  "/assets",
  createLimiter(60_000, 20),
  upload.single("file"),
  scanUploads,
  ProfileController.uploadAsset,
);
router.get(
  "/music/search",
  createLimiter(60_000, 30),
  ProfileController.searchMusic,
);
router.get(
  "/music/preview",
  createLimiter(60_000, 60),
  ProfileController.previewMusic,
);

export default router;
