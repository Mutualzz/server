import UsersController from "@mutualzz/rest/controllers/users.controller.ts";
import ProfileController from "@mutualzz/rest/controllers/@me/profile.controller.ts";
import SpotifyController from "@mutualzz/rest/controllers/@me/spotify.controller.ts";
import ConnectionsController from "@mutualzz/rest/controllers/@me/connections.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:identifier", createLimiter(60_000, 60), UsersController.get);
router.get(
    "/:identifier/profile",
    createLimiter(60_000, 60),
    ProfileController.get,
);
router.get(
    "/:identifier/recent-activities",
    createLimiter(60_000, 60),
    UsersController.getRecentActivities,
);
router.get(
    "/:identifier/spotify",
    createLimiter(60_000, 60),
    SpotifyController.getPublic,
);
router.get(
    "/:identifier/connections",
    createLimiter(60_000, 60),
    ConnectionsController.getPublic,
);

export default router;
