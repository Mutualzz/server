import AuthController from "@mutualzz/rest/controllers/auth.controller";
import { createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(`/login`, AuthController.login);
router.post(`/register`, AuthController.register);

export default router;
