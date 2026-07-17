import { createRouter } from "@mutualzz/util";
import ThemesController from "../controllers/themes.controller";

const router = createRouter();

router.get("/:themeId/background/:asset", ThemesController.getBackground);

export default router;
