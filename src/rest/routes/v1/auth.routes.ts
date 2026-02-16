import AuthController from "@mutualzz/rest/controllers/auth.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(`/login`, createLimiter(30_000, 10), AuthController.login);
router.post(`/register`, createLimiter(30_000, 10), AuthController.register);

export default router;
