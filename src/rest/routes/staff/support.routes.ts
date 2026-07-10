import StaffSupportController from "@mutualzz/rest/controllers/staffSupport.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), StaffSupportController.list);
router.get("/:ticketId", createLimiter(60_000, 60), StaffSupportController.get);
router.patch(
    "/:ticketId",
    createLimiter(60_000, 30),
    StaffSupportController.update,
);
router.post(
    "/:ticketId/messages",
    createLimiter(60_000, 30),
    StaffSupportController.reply,
);

export default router;
