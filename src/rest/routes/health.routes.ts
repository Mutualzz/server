import { createRouter } from "@mutualzz/util";
import HealthController from "../controllers/health.controller";

const router = createRouter();

router.get("/", HealthController.check);

export default router;
