import { createRouter } from "@mutualzz/util";
import MeThemesController from "../../../controllers/@me/themes.controller";

const router = createRouter();

router.put("/", MeThemesController.put);
router.patch("/:id", MeThemesController.patch);
router.delete("/:id", MeThemesController.delete);

export default router;
