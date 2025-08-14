import MeThemesController from "../../../controllers/@me/themes.controller";
import { createRouter } from "../../../utils";

const router = createRouter();

router.put("/", MeThemesController.putTheme);
router.patch("/", MeThemesController.patchTheme);
router.delete("/", MeThemesController.deleteTheme);

export default router;
