import { upload } from "@mutualzz/rest";
import MeController from "@mutualzz/rest/controllers/@me/index.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.patch(
    "/",
    createLimiter(60_000, 5),
    upload.single("avatar"),
    MeController.update,
);
router.patch(
    "/settings",
    createLimiter(60_000, 10),
    MeController.updateSettings,
);

export default router;
