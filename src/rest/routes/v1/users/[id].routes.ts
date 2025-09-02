import { createRouter } from "@mutualzz/util";
import UsersController from "rest/controllers/users.controller";

const router = createRouter();

router.get("/", UsersController.getUser);

export default router;
