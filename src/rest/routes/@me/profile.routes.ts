import { upload } from "@mutualzz/rest";
import ProfileController from "@mutualzz/rest/controllers/@me/profile.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.put("/", createLimiter(60_000, 20), ProfileController.update);
router.post(
    "/assets",
    createLimiter(60_000, 20),
    upload.single("file"),
    ProfileController.uploadAsset,
);
router.get(
    "/music/search",
    createLimiter(60_000, 30),
    ProfileController.searchMusic,
);

export default router;
