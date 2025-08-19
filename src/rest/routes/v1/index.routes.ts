import { createRouter } from "@mutualzz/util";
import MainController from "../../controllers/index.controller";

const router = createRouter();

router.get(`/ack`, MainController.ack);

export default router;
