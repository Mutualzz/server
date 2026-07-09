import StaffAppealsController from "@mutualzz/rest/controllers/staffAppeals.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 30), StaffAppealsController.list);
router.patch(
    "/:appealId",
    createLimiter(60_000, 30),
    StaffAppealsController.update,
);

export default router;
