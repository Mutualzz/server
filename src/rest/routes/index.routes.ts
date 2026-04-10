import MainController from "@mutualzz/rest/controllers/index.controller.ts";
import { createRouter } from "@mutualzz/util";

const router = createRouter();

router.get(`/ack`, MainController.ack);

export default router;
