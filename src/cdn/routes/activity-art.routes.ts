import { createRouter } from "@mutualzz/util";
import ActivityArtController from "../controllers/activityArt.controller";

const router = createRouter();

router.get("/:file", ActivityArtController.get);

export default router;
