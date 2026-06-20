import { createRouter } from "@mutualzz/util";
import ProfilesController from "../controllers/profiles.controller";

const router = createRouter();

router.get("/:userId/fonts/:font", ProfilesController.getFont);
router.get("/:userId/music/:music", ProfilesController.getMusic);

export default router;
