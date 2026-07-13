import SpotifyController from "@mutualzz/rest/controllers/@me/spotify.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
  "/complete",
  createLimiter(60_000, 30),
  SpotifyController.completeOAuth,
);

export default router;
