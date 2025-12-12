import UsersController from "@mutualzz/rest/controllers/users.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:id", createLimiter(60_000, 60), UsersController.get);

export default router;
