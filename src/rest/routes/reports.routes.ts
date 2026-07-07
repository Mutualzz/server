import ReportsController from "@mutualzz/rest/controllers/reports.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post("/", createLimiter(60_000, 10), ReportsController.create);

export default router;
