import UsersController from "@mutualzz/rest/controllers/users.controller.ts";
import ProfileController from "@mutualzz/rest/controllers/@me/profile.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:identifier", createLimiter(60_000, 60), UsersController.get);
router.get(
    "/:identifier/profile",
    createLimiter(60_000, 60),
    ProfileController.get,
);

export default router;
