import { createRouter } from "@mutualzz/util";
import AuthController from "../../controllers/auth.controller";

const router = createRouter();

router.post(`/login`, AuthController.login);
router.post(`/register`, AuthController.register);

export default router;
