import DiscordAuthController from "@mutualzz/rest/controllers/discordAuth.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get(
  "/link",
  createLimiter(60_000, 10),
  DiscordAuthController.createLinkUrl,
);
router.delete(
  "/",
  createLimiter(60_000, 10),
  DiscordAuthController.unlink,
);

export default router;
