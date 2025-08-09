import AuthController from "../../controllers/auth.controller";
import { createRouter } from "../../utils";

const router = createRouter();

router.post(`/login`, (...args) => AuthController.login(...args));
router.post(`/register`, (...args) => AuthController.register(...args));

export default router;
