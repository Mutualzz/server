import { createRouter } from "@mutualzz/util";
import AppIconsController from "../controllers/appIcons.controller";

const router = createRouter();

router.get("/:id", AppIconsController.get);

export default router;
