import { createRouter } from "@mutualzz/util";
import ApplicationsController from "../controllers/applications.controller";

const router = createRouter();

router.get("/:applicationId/:icon", ApplicationsController.getIcon);

export default router;
