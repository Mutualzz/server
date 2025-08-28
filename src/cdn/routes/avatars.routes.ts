import { createRouter } from "@mutualzz/util";
import AvatarsController from "../controllers/avatars.controller";

const router = createRouter();

router.get("/:userId/:avatar", AvatarsController.getAvatar);

export default router;
