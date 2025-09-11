import { createRouter } from "@mutualzz/util";
import PreviousAvatarController from "../../../controllers/@me/previousAvatar.controller";

const router = createRouter();

router.delete("/", PreviousAvatarController.deletePreviousAvatar);

export default router;
