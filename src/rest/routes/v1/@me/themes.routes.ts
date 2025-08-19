import { createRouter } from "@mutualzz/util";
import MeThemesController from "../../../controllers/@me/themes.controller";

const router = createRouter();

router.put("/", MeThemesController.putTheme);
router.patch("/", MeThemesController.patchTheme);
router.delete("/", MeThemesController.deleteTheme);

export default router;
