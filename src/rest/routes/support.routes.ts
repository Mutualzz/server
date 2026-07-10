import SupportController from "@mutualzz/rest/controllers/support.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), SupportController.list);
router.post("/", createLimiter(60_000, 10), SupportController.create);
router.get("/:ticketId", createLimiter(60_000, 60), SupportController.get);
router.post(
    "/:ticketId/messages",
    createLimiter(60_000, 20),
    SupportController.reply,
);

export default router;
