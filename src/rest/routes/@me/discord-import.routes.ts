import DiscordImportController from "@mutualzz/rest/controllers/discordImport.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get(
  "/bot-invite",
  createLimiter(60_000, 30),
  DiscordImportController.botInvite,
);
router.post(
  "/preview",
  createLimiter(60_000, 10),
  DiscordImportController.preview,
);
router.post(
  "/execute",
  createLimiter(60_000, 3),
  DiscordImportController.execute,
);

export default router;
