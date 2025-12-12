import MeThemesController from "@mutualzz/rest/controllers/@me/themes.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post("/", createLimiter(60_000, 30), MeThemesController.create);
router.patch("/:id", createLimiter(60_000, 30), MeThemesController.update);
router.delete("/:id", createLimiter(60_000, 20), MeThemesController.delete);

export default router;
