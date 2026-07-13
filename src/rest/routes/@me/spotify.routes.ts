import SpotifyController from "@mutualzz/rest/controllers/@me/spotify.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
  "/oauth",
  createLimiter(60_000, 10),
  SpotifyController.startOAuth,
);
router.get("/", createLimiter(60_000, 60), SpotifyController.getMe);
router.patch("/", createLimiter(60_000, 30), SpotifyController.patchMe);
router.delete("/", createLimiter(60_000, 10), SpotifyController.deleteMe);
router.get(
  "/currently-playing",
  createLimiter(60_000, 120),
  SpotifyController.currentlyPlaying,
);
router.post(
  "/playback/play",
  createLimiter(60_000, 60),
  SpotifyController.play,
);
router.post(
  "/playback/pause",
  createLimiter(60_000, 60),
  SpotifyController.pause,
);
router.post(
  "/playback/next",
  createLimiter(60_000, 60),
  SpotifyController.next,
);
router.post(
  "/playback/previous",
  createLimiter(60_000, 60),
  SpotifyController.previous,
);
router.post(
  "/playback/seek",
  createLimiter(60_000, 60),
  SpotifyController.seek,
);

export default router;
