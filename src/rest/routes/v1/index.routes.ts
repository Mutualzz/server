import MainController from "../../controllers/index.controller";
import { createRouter } from "../../utils";

const router = createRouter();

router.get(`/ack`, MainController.ack);

export default router;
