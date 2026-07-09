import AppealsController from "@mutualzz/rest/controllers/appeals.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post("/", createLimiter(60_000, 5), AppealsController.create);

export default router;
