import { createRouter } from "@mutualzz/util";
import AttachmentsController from "../controllers/attachments.controller";

const router = createRouter();

router.get("/:messageId/:filename", AttachmentsController.get);

export default router;
