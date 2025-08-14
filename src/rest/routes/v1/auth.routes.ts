import AuthController from "../../controllers/auth.controller";
import { createRouter } from "../../utils";

const router = createRouter();

router.post(`/login`, AuthController.login);
router.post(`/register`, AuthController.register);

export default router;
