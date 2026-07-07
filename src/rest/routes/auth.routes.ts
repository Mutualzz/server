import AuthController from "@mutualzz/rest/controllers/auth.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(`/login`, createLimiter(30_000, 10), AuthController.login);
router.post(`/logout`, createLimiter(30_000, 30), AuthController.logout);
router.post(`/register`, createLimiter(30_000, 10), AuthController.register);
router.post(
    "/forgot-password",
    createLimiter(30_000, 10),
    AuthController.forgotPassword,
);
router.post(
    "/reset-password",
    createLimiter(30_000, 10),
    AuthController.resetPassword,
);

export default router;
