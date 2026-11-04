import { createRouter } from "@mutualzz/util";
import ExternalController from "../controllers/external.controller";

const router = createRouter();

router.get("/:signature/:encoded", ExternalController.get);

export default router;
