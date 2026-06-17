import { createRouter } from "@mutualzz/util";
import ProfilesController from "../controllers/profiles.controller";

const router = createRouter();

router.get("/:userId/banner/:asset", ProfilesController.getBanner);
router.get("/:userId/background/:asset", ProfilesController.getBackground);
router.get("/:userId/music/:asset", ProfilesController.getMusic);

export default router;
