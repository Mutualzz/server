import { createRouter } from "@mutualzz/util";
import SpacesController from "../controllers/spaces.controller";

const router = createRouter();

router.get("/:spaceId/icons/:icon", SpacesController.getIcon);

export default router;
