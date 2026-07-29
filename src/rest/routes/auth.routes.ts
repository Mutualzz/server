import AuthController from "@mutualzz/rest/controllers/auth.controller.ts";
import DiscordAuthController from "@mutualzz/rest/controllers/discordAuth.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get(
  "/discord/url",
  createLimiter(60_000, 30),
  DiscordAuthController.createStartUrl,
);
router.post(
  "/discord/exchange",
  createLimiter(60_000, 30),
  DiscordAuthController.exchange,
);
router.post(
  "/discord/complete",
  createLimiter(60_000, 10),
  DiscordAuthController.complete,
);

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
