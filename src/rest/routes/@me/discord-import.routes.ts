import DiscordImportController from "@mutualzz/rest/controllers/discordImport.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
  "/preview",
  createLimiter(60_000, 10),
  DiscordImportController.preview,
);

export default router;
