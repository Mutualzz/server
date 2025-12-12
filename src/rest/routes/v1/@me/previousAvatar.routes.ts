import PreviousAvatarController from "@mutualzz/rest/controllers/@me/previousAvatar.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.delete("/", createLimiter(60_000, 10), PreviousAvatarController.delete);

export default router;
