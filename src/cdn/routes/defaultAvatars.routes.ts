import { createRouter } from "@mutualzz/util";
import DefaultAvatarsController from "../controllers/defaultAvatars.controller";

const router = createRouter();

router.get("/:id", DefaultAvatarsController.getDefaultAvatar);

export default router;
