import StaffReportsController from "@mutualzz/rest/controllers/staffReports.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 30), StaffReportsController.list);
router.get(
    "/:reportId",
    createLimiter(60_000, 60),
    StaffReportsController.getDetail,
);
router.patch(
    "/:reportId",
    createLimiter(60_000, 30),
    StaffReportsController.updateStatus,
);
router.post(
    "/:reportId/lockdown",
    createLimiter(60_000, 30),
    StaffReportsController.lockdown,
);
router.post(
    "/:reportId/takedown",
    createLimiter(60_000, 30),
    StaffReportsController.takedown,
);

export default router;
