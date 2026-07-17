import MeThemesController from "@mutualzz/rest/controllers/@me/themes.controller.ts";
import { scanUploads, upload } from "@mutualzz/rest";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post("/", createLimiter(60_000, 30), MeThemesController.create);
router.patch("/:themeId", createLimiter(60_000, 30), MeThemesController.update);
router.put(
  "/:themeId/background",
  createLimiter(60_000, 20),
  upload.single("backgroundImage"),
  scanUploads,
  MeThemesController.putBackground,
);
router.delete(
  "/:themeId/background",
  createLimiter(60_000, 20),
  MeThemesController.deleteBackground,
);
router.delete(
  "/:themeId",
  createLimiter(60_000, 20),
  MeThemesController.delete,
);

export default router;
