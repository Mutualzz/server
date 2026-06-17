import ProfileController from "@mutualzz/rest/controllers/@me/profile.controller.ts";
import { upload } from "@mutualzz/rest";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/music/search", createLimiter(60_000, 60), ProfileController.searchMusic);
router.get("/", createLimiter(60_000, 60), ProfileController.getMe);
router.put("/", createLimiter(60_000, 20), ProfileController.update);
router.post(
    "/assets",
    createLimiter(60_000, 30),
    upload.single("file"),
    ProfileController.uploadAsset,
);

export default router;
