import UsersController from "@mutualzz/rest/controllers/users.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:userId", createLimiter(60_000, 60), UsersController.get);

export default router;
