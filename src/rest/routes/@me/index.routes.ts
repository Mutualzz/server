import { upload } from "@mutualzz/rest";
import MeController from "@mutualzz/rest/controllers/@me/index.controller.ts";
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
router.post(
    "/verify-email",
    createLimiter(60_000, 5),
    MeController.verifyEmail,
);
router.post(
    "/send-email-code",
    createLimiter(3_600_000, 3),
    MeController.sendEmailCode,
);
router.post(
    "/change-password",
    createLimiter(60_000, 5),
    MeController.changePassword,
);

export default router;
